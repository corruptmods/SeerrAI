import type { AllSettings } from '@server/lib/settings';
import { siloDefaults } from '@server/lib/settings';

/**
 * Silo joined as a fourth media server. Settings saved before then get its
 * unconfigured defaults, and a Silo entry always has library lists and no
 * music libraries (Silo has none).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const migrateSiloDefaults = (settings: any): AllSettings => {
  const silo = settings.silo;
  if (!silo || typeof silo !== 'object' || Array.isArray(silo)) {
    settings.silo = siloDefaults();
    return settings;
  }
  if (!Array.isArray(silo.libraries)) {
    silo.libraries = [];
  }
  if (!Array.isArray(silo.musicLibraries) || silo.musicLibraries.length) {
    silo.musicLibraries = [];
  }
  return settings;
};

export default migrateSiloDefaults;
