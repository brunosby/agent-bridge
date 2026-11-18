import fs from 'node:fs';
import path from 'node:path';

/**
 * Role catalog: one JSON file per role in <app>/roles. Add a role by copying a file and changing it.
 * Fields: id, name, summary, canEdit ("all" | "none" | "tests"), recommended { label, patterns[] }, instructions,
 * fallback[] (roles to use when this one is missing), maxTurns (step limit, Claude agents), context ("diff": receives git diff + request).
 */
export function loadRoles(dir) {
  const roles = {};
  if (!fs.existsSync(dir)) return roles;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!r.id || !r.name) continue;
      roles[r.id] = {
        id: r.id,
        name: r.name,
        summary: r.summary || '',
        canEdit: ['all', 'none', 'tests'].includes(r.canEdit) ? r.canEdit : 'all',
        recommended: { label: r.recommended?.label || '', patterns: r.recommended?.patterns || [] },
        instructions: r.instructions || '',
        fallback: Array.isArray(r.fallback) ? r.fallback : [],
        maxTurns: Number(r.maxTurns) > 0 ? Number(r.maxTurns) : null,
        context: r.context === 'diff' ? 'diff' : null,
      };
    } catch {
      // a broken role file is skipped; the rest of the catalog still loads
    }
  }
  return roles;
}

/** True when a model id or label matches one of the role's recommended patterns. */
export function isRecommended(role, model) {
  const text = `${model?.value || ''} ${model?.label || ''} ${model?.resolved || ''}`;
  return (role?.recommended?.patterns || []).some((p) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}
