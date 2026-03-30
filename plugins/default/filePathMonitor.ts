import {
  HookEventType,
  PluginContext,
  PluginHandler,
  PluginParameters,
} from '../types';
import { getText } from '../utils';
import defaultFileScopes from '../../src/data/file-path-scope-defaults.json';

type FilePermission = 'read' | 'write' | 'delete';

type ScopeTarget = {
  path: string;
  kind: 'file' | 'folder' | 'glob' | 'unknown';
};

type Detection = {
  permission: FilePermission;
  scopeSource: 'query' | 'default';
  targets: ScopeTarget[];
  rationale: string;
};

const FILE_VERB_RULES: Record<FilePermission, RegExp[]> = {
  read: [
    /\b(read|open|view|show|check|inspect|list|cat|print|display|browse)\b/i,
    /(读取|查看|打开|浏览|检查|列出|看看|读一下|读一读)/,
  ],
  write: [
    /\b(write|edit|modify|update|change|append|create|generate|save|rewrite|patch|refactor|rename|move)\b/i,
    /(写入|写个|编辑|修改|更新|新增|创建|生成|保存|重写|补丁|重构|重命名|移动)/,
  ],
  delete: [
    /\b(delete|remove|rm|unlink|erase|clean|drop)\b/i,
    /(删除|移除|清理|抹掉)/,
  ],
};

const FILE_INTENT_HINTS = [
  /\b(file|files|folder|folders|directory|directories|path|paths|repo|repository|project)\b/i,
  /(文件|文件夹|目录|路径|仓库|项目|代码库)/,
];

const FILE_PATH_PATTERNS = [
  /`([^`\n]+)`/g,
  /"([^"\n]+)"/g,
  /'([^'\n]+)'/g,
  /(?:~\/|\/|\.\.\/|\.\/)[^\s"'`,;(){}[\]]+/g,
  /\b[\w.-]+\/[\w./*-]+\b/g,
  /\b[\w.-]+\.[a-zA-Z0-9]{1,10}\b/g,
];

function normalizeCandidatePath(value: string) {
  return value
    .trim()
    .replace(/^[`"'“”‘’]+/, '')
    .replace(/[`"'“”‘’，。；;,:]+$/, '');
}

function isProbablePath(value: string) {
  if (!value) {
    return false;
  }

  if (
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('*') ||
    value.startsWith('.') ||
    /\.[a-zA-Z0-9]{1,10}$/.test(value)
  ) {
    return true;
  }

  return /^(src|docs|plugins|tests|logs|tmp|config|build)$/i.test(value);
}

function getTargetKind(path: string): ScopeTarget['kind'] {
  if (path.includes('*')) {
    return 'glob';
  }

  if (path.endsWith('/')) {
    return 'folder';
  }

  if (/\.[a-zA-Z0-9]{1,10}$/.test(path)) {
    return 'file';
  }

  if (path.includes('/')) {
    return 'folder';
  }

  return 'unknown';
}

function extractPaths(query: string) {
  const paths = new Map<string, ScopeTarget>();

  for (const pattern of FILE_PATH_PATTERNS) {
    const matches = query.matchAll(pattern);

    for (const match of matches) {
      const rawValue = match[1] || match[0];
      const normalized = normalizeCandidatePath(rawValue);

      if (!isProbablePath(normalized)) {
        continue;
      }

      paths.set(normalized, {
        path: normalized,
        kind: getTargetKind(normalized),
      });
    }
  }

  return Array.from(paths.values());
}

function detectPermissions(query: string) {
  return Object.entries(FILE_VERB_RULES).reduce<FilePermission[]>(
    (acc, [permission, rules]) => {
      if (rules.some((rule) => rule.test(query))) {
        acc.push(permission as FilePermission);
      }

      return acc;
    },
    []
  );
}

function buildDefaultTargets(permission: FilePermission): ScopeTarget[] {
  return (defaultFileScopes.scopes[permission] || []).map((path) => ({
    path,
    kind: getTargetKind(path),
  }));
}

function buildRationale(permission: FilePermission, hasExplicitPaths: boolean) {
  const actionLabelMap: Record<FilePermission, string> = {
    read: '读取',
    write: '写入',
    delete: '删除',
  };

  return hasExplicitPaths
    ? `Query 中检测到“${actionLabelMap[permission]}”意图，且包含明确文件/目录路径。`
    : `Query 中检测到“${actionLabelMap[permission]}”意图，但没有明确路径，已回退到默认文件 scope。`;
}

export const handler: PluginHandler = async (
  context: PluginContext,
  _parameters: PluginParameters,
  eventType: HookEventType
) => {
  let error = null;
  let verdict = true;
  let data: any = null;

  try {
    const query = getText(context, eventType).trim();
    const explicitTargets = extractPaths(query);
    const permissions = detectPermissions(query);
    const hasFileIntent =
      permissions.length > 0 &&
      (explicitTargets.length > 0 ||
        FILE_INTENT_HINTS.some((pattern) => pattern.test(query)));

    const detections: Detection[] = hasFileIntent
      ? permissions.map((permission) => {
          const targets = explicitTargets.length
            ? explicitTargets
            : buildDefaultTargets(permission);

          return {
            permission,
            scopeSource: explicitTargets.length ? 'query' : 'default',
            targets,
            rationale: buildRationale(permission, explicitTargets.length > 0),
          };
        })
      : [];

    data = {
      type: 'file_path_monitor',
      moduleId: defaultFileScopes.moduleId,
      moduleName: defaultFileScopes.moduleName,
      matched: hasFileIntent,
      queryExcerpt: query.slice(0, 500),
      permissions,
      detections,
      protectedScopes: defaultFileScopes.protectedScopes,
      defaultScopes: defaultFileScopes.scopes,
      explanation: hasFileIntent
        ? `检测到 ${permissions.length} 类文件操作意图，并生成了对应的文件范围限制策略。`
        : '未检测到明确的文件或文件夹操作意图。',
    };
  } catch (e: any) {
    error = e;
    data = {
      type: 'file_path_monitor',
      moduleId: defaultFileScopes.moduleId,
      moduleName: defaultFileScopes.moduleName,
      matched: false,
      detections: [],
      protectedScopes: defaultFileScopes.protectedScopes,
      defaultScopes: defaultFileScopes.scopes,
      explanation: '文件路径监测模块执行失败。',
      error: e.message,
    };
  }

  return { error, verdict, data };
};
