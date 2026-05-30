import type { Doc } from './_generated/dataModel'

type Camp = Doc<'camps'>

export function isCampVisibleStatus(status: Camp['status']) {
  return status === 'active' || status === 'frozen' || status === 'grace'
}

export function isCampParticipableStatus(status: Camp['status']) {
  return status === 'active' || status === 'grace'
}

export function requiresActiveMembershipForVisibility(camp: Camp) {
  return camp.access === 'invite' || camp.status === 'frozen' || camp.status === 'grace'
}

export function isOwnerManageableCampStatus(status: Camp['status']) {
  return status === 'active'
}
