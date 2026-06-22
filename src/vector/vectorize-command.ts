import { vectorizeProject } from './code-to-vectors.js';

export async function runVectorizeCommand(projectPath: string): Promise<void> {
  const result = await vectorizeProject(projectPath);
  console.log(JSON.stringify(result, null, 2));
}
