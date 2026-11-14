import type { OmpStudioApi } from "../../shared/types";

declare global {
  interface Window {
    omp: OmpStudioApi;
  }
}

export {};
