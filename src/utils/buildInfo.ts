export const QAGENT_VERSION = process.env.QAGENT_VERSION ?? "0.1.0";
export const QAGENT_BUILD_SHA = process.env.QAGENT_BUILD_SHA ?? QAGENT_VERSION;

export function getBuildInfo(): {
  version: string;
  buildSha: string;
} {
  return {
    version: QAGENT_VERSION,
    buildSha: QAGENT_BUILD_SHA,
  };
}
