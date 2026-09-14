import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('文章观点树校验器通过本地单元测试', () => {
  const result = spawnSync('python', ['-m', 'unittest', 'extractor/test_answer_tree.py'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
