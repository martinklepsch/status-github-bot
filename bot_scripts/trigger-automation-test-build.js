// Description:
//   Script that listens for PRs moving into the 'TO TEST' column
//   and triggers a Jenkins build.
//
// Dependencies:
//   github: "^13.1.0"
//   jenkins: "^0.20.1"
//   probot-config: "^0.1.0"
//
// Author:
//   PombeirP

const getConfig = require('probot-config')
const jenkins = require('jenkins')({ baseUrl: process.env.JENKINS_URL, crumbIssuer: true, promisify: true })
const HashMap = require('hashmap')

const defaultConfig = require('../lib/config')
const gitHubHelpers = require('../lib/github-helpers')

const pendingPullRequests = new HashMap()

module.exports = (robot) => {
  if (!process.env.JENKINS_URL) {
    robot.log.info('trigger-automation-test-build - Jenkins is not configured, not loading script')
    return
  }

  setInterval(checkPendingPullRequests, 5 * 1000 * 60, robot)
  registerForRelevantCardEvents(robot)
}

function registerForRelevantCardEvents (robot) {
  robot.on(['project_card.created', 'project_card.moved'], context => processChangedProjectCard(robot, context))
}

function getRepoFullnameFromContentUrl (contentUrl) {
  const prefix = 'https://api.github.com/repos/'
  if (!contentUrl.startsWith(prefix)) {
    return null
  }

  const components = contentUrl.replace(prefix, '').split('/')

  return {owner: components[0], repo: components[1]}
}

async function processChangedProjectCard (robot, context) {
  const { github, payload } = context
  const repoFullName = getRepoFullnameFromContentUrl(payload.project_card.content_url)
  if (!repoFullName) {
    return
  }

  // HACK: probot-config needs to access the repo to get the config,
  // but that isn't provided in the project_card.* payloads,
  // so we fetch it ourselves and add it to the context
  try {
    context.repo = await github.repos.get(repoFullName)
  } catch (error) {
    robot.log.warn(`trigger-automation-test-build - Error while fetching repo`, repoFullName, error)
    return
  }

  const config = await getConfig(context, 'github-bot.yml', defaultConfig(robot, '.github/github-bot.yml'))
  const projectBoardConfig = config ? config['project-board'] : null
  const automatedTestsConfig = config ? config['automated-tests'] : null
  if (!projectBoardConfig || !automatedTestsConfig) {
    return
  }

  if (payload.project_card.note) {
    robot.log.trace(`trigger-automation-test-build - Card is a note, ignoring`)
    return
  }

  const projectBoardName = projectBoardConfig['name']
  const testColumnName = projectBoardConfig['test-column-name']

  if (repoFullName !== automatedTestsConfig['repo-full-name']) {
    robot.log.trace(`trigger-automation-test-build - Pull request project doesn't match watched repo, exiting`, repoFullName, automatedTestsConfig['repo-full-name'])
    return
  }

  let inTestColumn
  try {
    const columnPayload = await github.projects.getProjectColumn({ id: payload.project_card.column_id })

    if (columnPayload.data.name !== testColumnName) {
      robot.log.trace(`trigger-automation-test-build - Card column name doesn't match watched column name, exiting`, columnPayload.data.name, testColumnName)
      return
    }

    inTestColumn = columnPayload.data
  } catch (error) {
    robot.log.warn(`trigger-automation-test-build - Error while fetching project column`, payload.project_card.column_id, error)
    return
  }

  const last = (a, index) => {
    return a[a.length + index]
  }

  let project
  try {
    const projectId = last(inTestColumn.project_url.split('/'), -1)
    const projectPayload = await github.projects.getProject({ id: projectId })

    project = projectPayload.data
    if (project.name !== projectBoardName) {
      robot.log.trace(`trigger-automation-test-build - Card column name doesn't match watched column name, exiting`, project.name, projectBoardName)
      return
    }
  } catch (error) {
    robot.log.warn(`trigger-automation-test-build - Error while fetching project column`, payload.project_card.column_id, error)
    return
  }

  const prNumber = last(payload.project_card.content_url.split('/'), -1)
  const fullJobName = automatedTestsConfig['job-full-name']

  await processPullRequest(github, robot, repo.owner.login, repo.name, prNumber, fullJobName)
}

async function processPullRequest (github, robot, repoOwner, repoName, prNumber, fullJobName) {
  // Remove the PR from the pending PR list, if it is there
  pendingPullRequests.delete(prNumber)

  try {
    const state = await gitHubHelpers.getReviewApprovalState(github, robot, repoOwner, repoName, prNumber)

    switch (state) {
      case 'unstable':
      case 'awaiting_reviewers':
      case 'changes_requested':
        pendingPullRequests.set(prNumber, { github: github, repoOwner: repoOwner, repoName: repoName, fullJobName: fullJobName })
        robot.log.debug(`trigger-automation-test-build - State is '${state}', adding to backlog to check periodically`, prNumber)
        return
      case 'failed':
        robot.log.debug(`trigger-automation-test-build - State is '${state}', exiting`, prNumber)
        return
      case 'approved':
        robot.log.debug(`trigger-automation-test-build - State is '${state}', proceeding`, prNumber)
        break
      default:
        robot.log.warn(`trigger-automation-test-build - State is '${state}', ignoring`, prNumber)
        return
    }
  } catch (err) {
    robot.log.error(`Couldn't calculate the PR approval state: ${err}`, repoOwner, repoName, prNumber)
    return
  }

  try {
    const args = { parameters: { pr_id: prNumber, apk: `--apk=${prNumber}.apk` } }

    if (process.env.DRY_RUN) {
      robot.log(`trigger-automation-test-build - Would start ${fullJobName} job in Jenkins`, prNumber, args)
    } else {
      robot.log(`trigger-automation-test-build - Starting ${fullJobName} job in Jenkins`, prNumber, args)
      const buildId = await jenkins.job.build(fullJobName, args)
      robot.log(`trigger-automation-test-build - Started job in Jenkins`, prNumber, buildId)
    }
  } catch (error) {
    robot.log.error(`trigger-automation-test-build - Error while triggering Jenkins build. Will retry later`, prNumber, error)

    pendingPullRequests.set(prNumber, { github: github, repoOwner: repoOwner, repoName: repoName, fullJobName: fullJobName })
  }
}

async function checkPendingPullRequests (robot) {
  const _pendingPullRequests = pendingPullRequests.clone()

  robot.log.trace(`trigger-automation-test-build - Processing ${_pendingPullRequests.size} pending PRs`)

  for (const kvp of _pendingPullRequests.entries()) {
    const prNumber = kvp[0]
    const { github, repoOwner, repoName, fullJobName } = kvp[1]

    await processPullRequest(github, robot, repoOwner, repoName, prNumber, fullJobName)
  }

  robot.log.trace(`trigger-automation-test-build - Finished processing ${_pendingPullRequests.size} pending PRs`)
}
