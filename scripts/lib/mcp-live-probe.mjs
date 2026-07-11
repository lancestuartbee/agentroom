import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolvePencilCommand } from './mcp-health.mjs';

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const SLOW_START_PROBE_TIMEOUT_MS = 7000;
const CLOSE_TIMEOUT_MS = 300;
const MIN_STEP_TIMEOUT_MS = 100;

function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Probe timeout after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function sanitizeEnv(env) {
  const safe = { ...getDefaultEnvironment() };
  if (!env) return safe;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') safe[key] = value;
  }
  return safe;
}

function remainingTimeout(deadlineMs) {
  return Math.max(MIN_STEP_TIMEOUT_MS, deadlineMs - Date.now());
}

async function closeTransportBounded(transport) {
  await Promise.race([transport.close(), new Promise((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS))]);
}

function resolveProbeTimeoutMs(capability, overrideTimeoutMs) {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }

  const command = capability?.mcpServer?.command?.toLowerCase() ?? '';
  const args = capability?.mcpServer?.args ?? [];
  const argsLower = args.map((arg) => arg.toLowerCase());
  const argsJoined = argsLower.join(' ');

  const isNpxLike = command === 'npx' || command === 'pnpm' || command === 'pnpmx';
  const looksLikePlaywright = argsJoined.includes('playwright');
  const isDlx = argsJoined.includes('dlx') || argsJoined.includes('-y');
  if (isNpxLike && (isDlx || looksLikePlaywright)) return SLOW_START_PROBE_TIMEOUT_MS;

  const isDockerGatewayRun =
    command === 'docker' && argsLower[0] === 'mcp' && argsLower[1] === 'gateway' && argsLower[2] === 'run';
  if (isDockerGatewayRun) return SLOW_START_PROBE_TIMEOUT_MS;

  return DEFAULT_PROBE_TIMEOUT_MS;
}

function normalizeToolNames(tools) {
  const names = new Set();
  for (const tool of tools ?? []) {
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (name) names.add(name);
  }
  return [...names].sort();
}

async function resolveProbeCommand(capability, options) {
  let command = capability.mcpServer.command;
  let args = capability.mcpServer.args ?? [];
  if (command?.trim()) return { command, args };
  if (capability.mcpServer.resolver !== 'pencil') return null;

  const resolved = await resolvePencilCommand({ repoRoot: options.projectRoot, env: options.env });
  if (!resolved) return null;
  command = resolved.command;
  args = resolved.args;
  return command?.trim() ? { command, args } : null;
}

function buildServerParams(command, args, capability, options) {
  const serverParams = {
    command,
    args,
    cwd: capability.mcpServer.workingDir ?? options.projectRoot ?? process.cwd(),
    stderr: 'ignore',
  };
  const env = sanitizeEnv(capability.mcpServer.env ?? options.env);
  if (env && Object.keys(env).length > 0) serverParams.env = env;
  return serverParams;
}

export async function probeMcpCapabilityLive(capability, options = {}) {
  if (capability?.type !== 'mcp') return { connectionStatus: 'unknown' };
  if (!capability.mcpServer) return { connectionStatus: 'unknown' };

  const resolved = await resolveProbeCommand(capability, options);
  if (!resolved) return { connectionStatus: 'unknown' };

  const timeoutMs = resolveProbeTimeoutMs(capability, options.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  const serverParams = buildServerParams(resolved.command, resolved.args, capability, options);
  const transport = new StdioClientTransport(serverParams);
  const client = new Client({ name: 'cat-cafe-mcp-doctor', version: '0.1.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), remainingTimeout(deadlineMs));
    const result = await withTimeout(client.listTools(), remainingTimeout(deadlineMs));
    return {
      connectionStatus: 'connected',
      tools: normalizeToolNames(result.tools),
    };
  } catch (error) {
    return {
      connectionStatus: 'disconnected',
      tools: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await closeTransportBounded(transport).catch(() => {});
  }
}
