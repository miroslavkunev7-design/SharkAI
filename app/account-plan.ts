export type AccountPlan = { plan: string; lifetime?: boolean };

export function hasLifetimeUltra(account: AccountPlan) {
  return account.plan === 'ULTRA' && account.lifetime === true;
}

export function accountPlanLabel(account: AccountPlan, prefix = '') {
  return hasLifetimeUltra(account) ? 'ULTRA · Безсрочен достъп' : `${prefix}${account.plan}`;
}
