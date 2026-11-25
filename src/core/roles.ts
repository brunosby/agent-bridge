import fs from 'node:fs';
import path from 'node:path';
import type { ModelInfo, Role, RoleCatalog } from './types.ts';

/**
 * Role catalog: one JSON file per role in <app>/roles. Add a role by copying a file and changing it.
 * Fields: id, name, summary, canEdit ("all" | "none" | "tests"), recommended { label, patterns[] }, instructions,
 * fallback[] (roles to use when this one is missing), maxTurns (step limit, Claude agents),
 * context ("diff": receives git diff + request), profile ("full" | "lean": lean runs without hooks),
 * skillsOff[] (skill name patterns switched off for the role, e.g. "*:long-task").
 */
export function loadRoles(dir: string): RoleCatalog {
  const roles: RoleCatalog = {};
  if (!fs.existsSync(dir)) return roles;
  for (const f of fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort()) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!r.id || !r.name) continue;
      const valid = ['all', 'none', 'tests'].includes(r.canEdit);
      const warning = valid ? undefined : 'Invalid canEdit in ' + f + '. Using read-only permissions.';
      if (warning) console.warn(warning);
      roles[r.id] = {
        id: r.id,
        name: r.name,
        summary: r.summary || '',
        canEdit: valid ? r.canEdit : 'none',
        warning,
        recommended: { label: r.recommended?.label || '', patterns: r.recommended?.patterns || [] },
        instructions: r.instructions || '',
        fallback: Array.isArray(r.fallback) ? r.fallback : [],
        maxTurns: Number(r.maxTurns) > 0 ? Number(r.maxTurns) : null,
        context: r.context === 'diff' ? 'diff' : null,
        profile: r.profile === 'lean' ? 'lean' : 'full',
        skillsOff: Array.isArray(r.skillsOff) ? r.skillsOff : [],
      };
    } catch {
      // a broken role file is skipped; the rest of the catalog still loads
    }
  }
  return roles;
}

/** Glob match for skill names: * matches anything (e.g. "*:long-task"). */
export function globMatch(pattern: string, name: string): boolean {
  const escaped = String(pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, (c) => `\\${c}`))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(String(name));
}

/** True when a model id or label matches one of the role's recommended patterns. */
export function isRecommended(role: Pick<Role, 'recommended'> | undefined, model: Partial<ModelInfo> | undefined): boolean {
  const text = `${model?.value || ''} ${model?.label || ''} ${model?.resolved || ''}`;
  return (role?.recommended?.patterns || []).some((p: string) => {
    try {
      return new RegExp(p, 'i').test(text);
    } catch {
      return false;
    }
  });
}
