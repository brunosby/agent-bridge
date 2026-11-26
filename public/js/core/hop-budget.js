/** Shared by the live relay and the preview in Settings.
 * @param {string} mode
 * @param {number} base
 * @param {{size: 'small' | 'medium' | 'large', classified: boolean}} [plan]
 */
export function hopBudget(mode, base, plan) {
  const size = mode === 'orchestrator' && plan?.classified ? plan.size : undefined;
  const multiplier = size === 'large' ? 4 : size === 'medium' ? 2 : 1;
  return { limit: base * multiplier, size };
}
