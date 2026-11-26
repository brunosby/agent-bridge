import type { RoutingMode, TaskPlan } from './types.ts';

export function hopBudget(mode: RoutingMode, base: number, plan?: TaskPlan) {
  const size = mode === 'orchestrator' && plan?.classified ? plan.size : undefined;
  const multiplier = size === 'large' ? 4 : size === 'medium' ? 2 : 1;
  return { limit: base * multiplier, size };
}

export function hopCost(mode: RoutingMode, lead: string | undefined, from: string, to: string) {
  return Number(mode !== 'orchestrator' || (from === lead && to !== lead));
}
