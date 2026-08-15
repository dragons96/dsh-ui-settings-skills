/**
 * ui-settings-skills browser half: the Skill management page in Web Settings.
 * Registers one `settings.section` ("skill-management") and loads the catalog
 * from the host half's HTTP route.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the client Context merge and the LocaleNamespaceMap face.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SkillManagementSection } from './SkillManagementSection.tsx'
import type { SkillManagementSectionInjected } from './SkillManagementSection.tsx'
import { en, NS, zh, type SkillManagementKey } from './locales.ts'
import type { CatalogResponse, ErrorResponse } from '../wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skill-management settings page copy. */
    'settings.skillManagement': SkillManagementKey
  }
}

export { NS }

/** Services required by the settings-section registration. */
export const inject = ['slots', 'locale']

/** Load the catalog from the host half's route, rejecting on transport or HTTP errors. */
async function loadCatalog(): Promise<CatalogResponse> {
  const response = await fetch('/plugin/settings-skills/catalog', { headers: { accept: 'application/json' } })
  const body = await response.json() as CatalogResponse | ErrorResponse
  if (!response.ok || !('dimensions' in body)) {
    const message = 'error' in body
      ? `${body.error.code}: ${body.error.message}`
      : `catalog request failed with status ${response.status}`
    throw new Error(message)
  }
  return body
}

/** Contribute the Skill management page to the settings shell. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-skills: dictionaries')

  const injected = (): SkillManagementSectionInjected => ({ load: loadCatalog })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'skill-management',
    order: 30,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, SkillManagementSection))
}
