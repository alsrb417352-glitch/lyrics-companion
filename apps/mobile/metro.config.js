// Metro 설정: 앱 폴더 밖의 core 패키지(../../packages/core)를 번들에 포함한다.
// core는 TypeScript 소스를 그대로 내보내며 내부 import에 '.js' 확장자를 쓴다(Node ESM 규칙).
// Metro는 '.js' → '.ts' 대응을 하지 않으므로 core 내부 상대 경로에 한해 '.ts'로 바꿔 해석한다.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const coreRoot = path.resolve(projectRoot, '../../packages/core');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [...(config.watchFolders ?? []), coreRoot];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && isInside(context.originModulePath, coreRoot)) {
    try {
      return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
    } catch {
      // .ts가 없으면 원래 이름으로 해석
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
