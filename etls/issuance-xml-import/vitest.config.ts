import * as path from 'path';
import * as ts from 'typescript';
import { defineConfig, Plugin } from 'vitest/config';

//the e2e setup builds the test schema from server/src/entities with a typeorm DataSource. the entities need
//emitDecoratorMetadata (an untyped @Column() reads its type from design:type), which esbuild does not implement, so
//those files, and only those, go through typescript's own transpiler before vite sees them
const ENTITIES = path.resolve(__dirname, '../../server/src/entities').split(path.sep).join('/');

const decoratorMetadata: Plugin = {
  name: 'typeorm-entities-decorator-metadata',
  enforce: 'pre',
  transform(code, id) {
    if (!id.split(path.sep).join('/').startsWith(ENTITIES) || !id.endsWith('.ts')) return null;
    const out = ts.transpileModule(code, {
      fileName: id,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true },
    });
    return { code: out.outputText, map: null };
  },
};

export default defineConfig({
  plugins: [decoratorMetadata],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    //the e2e files share one database, so files run one after the other
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 90000,
  },
});
