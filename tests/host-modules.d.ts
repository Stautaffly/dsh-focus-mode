declare module 'virtual:dsh-host-modules' {
  export const sources: Record<string, () => Promise<unknown>>
  export const manifests: Record<string, { name: string }>
}
