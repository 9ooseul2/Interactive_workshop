/** Returns a public-directory asset URL that also works on GitHub Project Pages. */
export function publicAssetUrl(path: string) {
  return `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
}
