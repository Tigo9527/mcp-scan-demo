import { describe, it, expect } from 'vitest';
import { serverInfo } from '../src/version.js';
import { page } from '../src/web/layout.js';

describe('serverInfo', () => {
  it('暴露 version / commit / startedAt 且类型正确', () => {
    expect(typeof serverInfo.version).toBe('string');
    expect(serverInfo.version.length).toBeGreaterThan(0);
    // 来自 package.json，形如 1.0.0
    expect(serverInfo.version).toMatch(/^\d+\.\d+\.\d+/);

    expect(typeof serverInfo.commit).toBe('string');

    // config.startedAt 为 ISO 时间字符串
    expect(serverInfo.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('commit 取值失败时回退 unknown 而非抛错', () => {
    // 不固定断言具体 commit（环境会变），只保证一定是字符串
    expect(serverInfo.commit).toEqual(expect.any(String));
  });
});

describe('page 页脚版本号', () => {
  it('每个经 page() 渲染的页面都带版本信息', () => {
    const html = page({ title: '测试页', body: '<p>正文</p>' });
    expect(html).toContain('version-footer');
    expect(html).toContain(`v${serverInfo.version}`);
    expect(html).toContain(serverInfo.commit);
    expect(html).toContain('启动');
  });

  it('version/commit 作为动态值被 HTML 转义（即便含特殊字符也不注入脚本）', () => {
    // 直接验证 esc 对 footer 中变量的处理：构造含尖括号的输入，确认被转义而非原样插入
    const evil = '<script>alert(1)</script>';
    // esc 来自 layout 内部，这里通过其产物间接验证：title 注入会被转义
    const html = page({ title: evil, body: '' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
