import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'jarv-genie';
export const VERSION = '0.1.0';
export const SERVER_NAME = 'jarv-genie';
export const MCP_VERSION = '0.1.0';

export function dataHome(): string {
  return path.join(os.homedir(), '.jarv-genie');
}

export function configPath(): string {
  return path.join(dataHome(), 'config.json');
}
