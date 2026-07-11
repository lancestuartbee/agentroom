import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface ArtifactStoreEnv {
  CAT_CAFE_ARTIFACT_ROOT?: string;
  AGENTROOM_ARTIFACT_ROOT?: string;
  CAT_CAFE_ARTIFACT_PROFILE?: string;
  REDIS_STORAGE_KEY?: string;
  REDIS_PROFILE?: string;
  REDIS_PORT?: string;
  HOME?: string;
  USERPROFILE?: string;
}

export interface ArtifactStorePaths {
  root: string;
  profileKey: string;
  profileRoot: string;
  threadDir: string;
  reportsDir: string;
  metadataDir: string;
}

const DEFAULT_REDIS_PORT = '6399';

export function sanitizeArtifactPathSegment(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) return fallback;
  const normalized = trimmed
    .replace(/[/\\:]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return normalized || fallback;
}

function expandHomePath(raw: string, env: ArtifactStoreEnv): string {
  const home = env.HOME || env.USERPROFILE || homedir();
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : resolve(raw);
}

export function resolveArtifactRoot(env: ArtifactStoreEnv = process.env as ArtifactStoreEnv): string {
  const configured = env.CAT_CAFE_ARTIFACT_ROOT?.trim() || env.AGENTROOM_ARTIFACT_ROOT?.trim();
  if (configured) return resolve(expandHomePath(configured, env));
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, 'Documents', 'AgentRoom');
}

export function resolveArtifactProfileKey(env: ArtifactStoreEnv = process.env as ArtifactStoreEnv): string {
  const explicit = env.CAT_CAFE_ARTIFACT_PROFILE?.trim();
  if (explicit) return sanitizeArtifactPathSegment(explicit, 'default');

  const storageKey = env.REDIS_STORAGE_KEY?.trim();
  if (storageKey) return sanitizeArtifactPathSegment(storageKey, 'default');

  const redisPort = env.REDIS_PORT?.trim();
  if (redisPort && redisPort !== DEFAULT_REDIS_PORT) {
    const redisProfile = sanitizeArtifactPathSegment(env.REDIS_PROFILE?.trim() || 'default', 'default');
    return sanitizeArtifactPathSegment(`${redisProfile}-${redisPort}`, 'default');
  }

  return 'default';
}

export function resolveThreadArtifactPaths(
  threadId: string,
  env: ArtifactStoreEnv = process.env as ArtifactStoreEnv,
): ArtifactStorePaths {
  const root = resolveArtifactRoot(env);
  const profileKey = resolveArtifactProfileKey(env);
  const threadSegment = sanitizeArtifactPathSegment(threadId, 'thread');
  const profileRoot = join(root, 'profiles', profileKey);
  const threadDir = join(profileRoot, 'threads', threadSegment);
  return {
    root,
    profileKey,
    profileRoot,
    threadDir,
    reportsDir: join(threadDir, 'reports'),
    metadataDir: join(threadDir, '.metadata'),
  };
}
