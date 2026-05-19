export function normalizeDefaultBackground(defaultBackground?: string | null): string | null {
  if (defaultBackground === null) {
    return 'transparent';
  }

  if (!defaultBackground) {
    return null;
  }

  if (defaultBackground.trim().toLowerCase() === 'null') {
    return 'transparent';
  }

  return defaultBackground.startsWith('#') ? defaultBackground : `#${defaultBackground}`;
}