import type { CancunApi } from '../../preload/index'

declare global {
  interface Window {
    cancun: CancunApi
  }
}
export {}
