import type { RoutingMode } from './types.ts';
export { hopBudget } from '../../public/js/core/hop-budget.js';

export function hopCost(mode: RoutingMode, lead: string | undefined, from: string, to: string) {
  return Number(mode !== 'orchestrator' || (from === lead && to !== lead));
}
