import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../src/db/index.js';
import { IxMappingRepo, IxProviderRepo } from '../src/db/repo/ix.js';
import { deriveKey, encryptSecret } from '../src/core/secret.js';
import type { Db } from '../src/db/index.js';
import type { Logger } from '../src/logger.js';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => logger };

let db: Db;
let providers: IxProviderRepo;
let mappings: IxMappingRepo;

function openDb(): Db {
  const fresh = new Database(':memory:');
  // 级联删除依赖外键约束，而它默认是关的 —— openDatabase() 会开，
  // 裸 new Database 不会。忘了这行，级联那条断言会假绿。
  fresh.pragma('foreign_keys = ON');
  migrate(fresh, logger);
  return fresh;
}

beforeEach(() => {
  db = openDb();
  providers = new IxProviderRepo(db);
  mappings = new IxMappingRepo(db);
});

describe('IxProviderRepo', () => {
  it('增删改查与「只取启用的」', () => {
    const created = providers.create({ name: 'zf', baseUrl: 'https://relay.example.com/api', username: 'relay-user' });
    expect(created).toMatchObject({
      name: 'zf',
      baseUrl: 'https://relay.example.com/api',
      authMode: 'login',
      username: 'relay-user',
      enabled: true,
      enableUdp: true,
      defaultLineId: null,
      lastError: null,
      quotaJson: null,
    });
    expect(providers.get(created.id)).toEqual(created);
    expect(providers.list()).toHaveLength(1);

    const off = providers.create({ name: 'disabled', baseUrl: 'https://example.test/api', enabled: false });
    expect(providers.list()).toHaveLength(2);
    expect(providers.listEnabled().map((p) => p.id)).toEqual([created.id]);

    expect(providers.delete(off.id)).toBe(true);
    expect(providers.delete(off.id)).toBe(false);
    expect(providers.get(off.id)).toBeUndefined();
  });

  it('部分更新只动传入的字段，不清掉 JWT 缓存与额度快照', () => {
    const p = providers.create({ name: 'zf', baseUrl: 'https://relay.example.com/api' });
    providers.update(p.id, { jwtEnc: 'v1:cached', jwtExpiresAt: 9_999, quotaJson: '{"ports":3}' });

    // 只拨总闸 —— 会话与快照必须原样留着，否则下一轮同步得重登
    const toggled = providers.update(p.id, { enabled: false });
    expect(toggled).toMatchObject({
      enabled: false,
      jwtEnc: 'v1:cached',
      jwtExpiresAt: 9_999,
      quotaJson: '{"ports":3}',
      name: 'zf',
    });

    // 显式传 null 才清空
    expect(providers.update(p.id, { jwtEnc: null, jwtExpiresAt: null })).toMatchObject({
      jwtEnc: null,
      jwtExpiresAt: null,
      quotaJson: '{"ports":3}',
    });

    // 空 patch 不炸、不改任何东西
    const before = providers.get(p.id)!;
    expect(providers.update(p.id, {})).toEqual(before);
    expect(providers.update('missing-id', { name: 'x' })).toBeUndefined();
  });

  it('凭据以密文原样进出，库里存的不是明文', () => {
    const key = deriveKey('admin-token-for-tests-0123456789');
    const password = 'zf-real-password-字符';
    const apiKey = 'zf-api-key-abcdef';
    const p = providers.create({
      name: 'zf',
      baseUrl: 'https://relay.example.com/api',
      authMode: 'api-key',
      username: 'relay-user',
      passwordEnc: encryptSecret(password, key),
      apiKeyEnc: encryptSecret(apiKey, key),
    });

    expect(p.authMode).toBe('api-key');
    expect(p.passwordEnc).toMatch(/^v1:/);
    expect(p.apiKeyEnc).toMatch(/^v1:/);

    // 把整行拼成字符串扫一遍：明文一个字都不能出现在任何列里
    const row = db.prepare('SELECT * FROM ix_providers WHERE id = ?').get(p.id) as Record<string, unknown>;
    const dump = JSON.stringify(row);
    expect(dump).not.toContain(password);
    expect(dump).not.toContain(apiKey);
    expect(dump).toContain('v1:');

    // 密文一字节不差地回来（仓储层不许做任何"顺手规整"）
    expect(providers.get(p.id)!.passwordEnc).toBe(p.passwordEnc);
  });

  it('auth_mode 存了怪值时兜底成能力最弱的 login，而不是抛异常', () => {
    const p = providers.create({ name: 'zf', baseUrl: 'https://relay.example.com/api' });
    db.prepare('UPDATE ix_providers SET auth_mode = ? WHERE id = ?').run('oauth-from-the-future', p.id);
    expect(providers.get(p.id)!.authMode).toBe('login');
  });
});

describe('IxMappingRepo', () => {
  function seedProvider(name = 'zf') {
    return providers.create({ name, baseUrl: 'https://relay.example.com/api' });
  }

  it('upsert 幂等：同一 (provider_id, fingerprint) 写两次只有一行，字段被更新', () => {
    const p = seedProvider();
    const first = mappings.upsert({
      providerId: p.id,
      fingerprint: 'fp-a',
      targetHost: 'landing-a.example',
      targetPort: 2002,
    });
    expect(first).toMatchObject({
      state: 'pending',
      entryHost: null,
      entryPort: null,
      remotePortId: null,
      suspended: false,
      missingCount: 0,
    });

    const second = mappings.upsert(
      {
        providerId: p.id,
        fingerprint: 'fp-a',
        targetHost: 'landing-a.example',
        targetPort: 2002,
        remotePortId: 230,
        entryHost: 'entry.relay.example',
        entryPort: 51221,
        lineId: 20,
        lineName: '腾讯上海P',
        state: 'active',
      },
      first.createdAt + 5_000,
    );

    expect(mappings.list(p.id)).toHaveLength(1);
    expect(second).toMatchObject({
      remotePortId: 230,
      entryHost: 'entry.relay.example',
      entryPort: 51221,
      lineName: '腾讯上海P',
      state: 'active',
    });
    // created_at 保住（同 nodes 表保 first_seen 的理由），updated_at 前进
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('upsert 不覆盖本次没传的字段——补一次延迟数据不该把 state 打回 pending', () => {
    const p = seedProvider();
    mappings.upsert({
      providerId: p.id,
      fingerprint: 'fp-a',
      targetHost: 'landing-a.example',
      targetPort: 2002,
      state: 'active',
      entryHost: 'entry.relay.example',
      entryPort: 51221,
    });

    const refreshed = mappings.upsert({
      providerId: p.id,
      fingerprint: 'fp-a',
      targetHost: 'landing-a.example',
      targetPort: 2002,
      latencyUs: 133_464,
      lossRate: 0.02,
      trafficIn: 452,
      trafficOut: 1_432,
    });

    expect(refreshed).toMatchObject({
      state: 'active',
      entryHost: 'entry.relay.example',
      entryPort: 51221,
      latencyUs: 133_464,
      lossRate: 0.02,
      trafficIn: 452,
      trafficOut: 1_432,
    });
  });

  it('entry_udp 三态往返：true / false / NULL（未知），三者互不塌缩', () => {
    const p = seedProvider();
    const base = { providerId: p.id, targetHost: 'landing-a.example', targetPort: 2002 };

    // 没传这一列 = 还没同步过。**必须**是 null 而不是 false ——
    // 混淆这两者正是"输出 UDP 黑洞死节点"那条 bug 的入口。
    expect(mappings.upsert({ ...base, fingerprint: 'fp-unknown' }).entryUdp).toBeNull();
    expect(mappings.upsert({ ...base, fingerprint: 'fp-on', entryUdp: true }).entryUdp).toBe(true);
    expect(mappings.upsert({ ...base, fingerprint: 'fp-off', entryUdp: false }).entryUdp).toBe(false);

    // update 能在三态之间双向走，尤其能从 true/false 退回"未知"
    expect(mappings.update(p.id, 'fp-on', { entryUdp: false })!.entryUdp).toBe(false);
    expect(mappings.update(p.id, 'fp-on', { entryUdp: null })!.entryUdp).toBeNull();
    expect(mappings.update(p.id, 'fp-on', { entryUdp: true })!.entryUdp).toBe(true);

    // 不传这一列的更新不动它（refresh 之外的补丁不该顺手抹掉平台事实）
    expect(mappings.update(p.id, 'fp-off', { state: 'active' })!.entryUdp).toBe(false);
    expect(
      mappings.upsert({ ...base, fingerprint: 'fp-off', latencyUs: 1_234 }).entryUdp,
    ).toBe(false);

    // 库里落的是 0/1/NULL 三种值，0 是"平台明说不转"，不是"未知"
    const rows = db
      .prepare('SELECT fingerprint, entry_udp FROM ix_port_mappings ORDER BY fingerprint')
      .all() as { fingerprint: string; entry_udp: number | null }[];
    expect(rows).toEqual([
      { fingerprint: 'fp-off', entry_udp: 0 },
      { fingerprint: 'fp-on', entry_udp: 1 },
      { fingerprint: 'fp-unknown', entry_udp: null },
    ]);
  });

  it('批量按指纹一次查回，未映射的指纹不出现在结果里', () => {
    const p = seedProvider();
    const other = seedProvider('zf-2');
    for (const [fp, port] of [['fp-a', 2002], ['fp-b', 2004], ['fp-c', 2006]] as const) {
      mappings.upsert({ providerId: p.id, fingerprint: fp, targetHost: 'landing-a.example', targetPort: port });
    }
    mappings.upsert({ providerId: other.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });

    const found = mappings.listByFingerprints(p.id, ['fp-a', 'fp-c', 'fp-does-not-exist']);
    expect(found.map((m) => m.fingerprint).sort()).toEqual(['fp-a', 'fp-c']);
    // provider 隔离：另一个 provider 的同名指纹不能混进来
    expect(found.every((m) => m.providerId === p.id)).toBe(true);
    expect(mappings.listByFingerprints(p.id, [])).toEqual([]);

    // 渲染热路径：一次拿全，key 为指纹
    const map = mappings.mapForProvider(p.id);
    expect([...map.keys()].sort()).toEqual(['fp-a', 'fp-b', 'fp-c']);
    expect(map.get('fp-b')!.targetPort).toBe(2004);

    // 跨 provider 反查
    expect(mappings.findByFingerprint('fp-a')).toHaveLength(2);
    expect(mappings.count(p.id)).toBe(3);
    expect(mappings.count(other.id)).toBe(1);
    expect(mappings.list()).toHaveLength(4);
  });

  it('批量查超过单次绑定参数上限时仍能一次性拿全（分块）', () => {
    const p = seedProvider();
    const fingerprints = Array.from({ length: 1_000 }, (_, i) => `fp-${i}`);
    const insertAll = db.transaction(() => {
      for (const [index, fingerprint] of fingerprints.entries()) {
        mappings.upsert({ providerId: p.id, fingerprint, targetHost: 'landing-a.example', targetPort: 2000 + index });
      }
    });
    insertAll();
    expect(mappings.listByFingerprints(p.id, fingerprints)).toHaveLength(1_000);
  });

  it('missing_count 累加与重置', () => {
    const p = seedProvider();
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });

    expect(mappings.bumpMissing(p.id, 'fp-a')).toBe(1);
    expect(mappings.bumpMissing(p.id, 'fp-a')).toBe(2);
    expect(mappings.bumpMissing(p.id, 'fp-a')).toBe(3);

    // 节点又回来了 —— 必须清零，否则健康节点迟早被误标成孤儿
    mappings.resetMissing(p.id, 'fp-a');
    expect(mappings.get(p.id, 'fp-a')!.missingCount).toBe(0);

    // upsert 不该顺手把计数抹掉（它不在覆盖列表里）
    mappings.bumpMissing(p.id, 'fp-a');
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002, state: 'active' });
    expect(mappings.get(p.id, 'fp-a')!.missingCount).toBe(1);

    // 不存在的映射不炸
    expect(mappings.bumpMissing(p.id, 'fp-nope')).toBe(0);
  });

  it('state 流转：pending → active → error → orphan，按状态可筛', () => {
    const p = seedProvider();
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-b', targetHost: 'landing-a.example', targetPort: 2004 });
    expect(mappings.listByState('pending', p.id)).toHaveLength(2);

    mappings.update(p.id, 'fp-a', { state: 'active', remotePortId: 230, entryHost: 'entry.relay.example', entryPort: 51221 });
    expect(mappings.listByState('active', p.id).map((m) => m.fingerprint)).toEqual(['fp-a']);

    mappings.update(p.id, 'fp-a', { state: 'error', lastError: '配额已满：30/30', suspended: true, syncError: '下发失败' });
    expect(mappings.get(p.id, 'fp-a')).toMatchObject({
      state: 'error',
      lastError: '配额已满：30/30',
      suspended: true,
      syncError: '下发失败',
      // 状态变了但入口信息留着 —— 排障要看它，也便于恢复后直接复用
      remotePortId: 230,
      entryPort: 51221,
    });

    mappings.update(p.id, 'fp-b', { state: 'orphan', missingCount: 5 });
    expect(mappings.listByState('orphan').map((m) => m.fingerprint)).toEqual(['fp-b']);

    expect(mappings.update(p.id, 'fp-a', {})).toMatchObject({ state: 'error' });
    expect(mappings.update(p.id, 'fp-missing', { state: 'active' })).toBeUndefined();
  });

  it('state 存了库外的怪值时兜底成 error，绝不兜成 active', () => {
    const p = seedProvider();
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });
    db.prepare('UPDATE ix_port_mappings SET state = ? WHERE fingerprint = ?').run('half-built', 'fp-a');
    expect(mappings.get(p.id, 'fp-a')!.state).toBe('error');
  });

  it('删 provider 连带删映射（ON DELETE CASCADE）', () => {
    const p = seedProvider();
    const keep = seedProvider('zf-2');
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-b', targetHost: 'landing-a.example', targetPort: 2004 });
    mappings.upsert({ providerId: keep.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });

    expect(providers.delete(p.id)).toBe(true);
    expect(mappings.list(p.id)).toEqual([]);
    expect(mappings.list(keep.id)).toHaveLength(1);
  });

  it('单条删除只删那一条', () => {
    const p = seedProvider();
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-a', targetHost: 'landing-a.example', targetPort: 2002 });
    mappings.upsert({ providerId: p.id, fingerprint: 'fp-b', targetHost: 'landing-a.example', targetPort: 2004 });

    expect(mappings.delete(p.id, 'fp-a')).toBe(true);
    expect(mappings.delete(p.id, 'fp-a')).toBe(false);
    expect(mappings.list(p.id).map((m) => m.fingerprint)).toEqual(['fp-b']);
  });

  it('映射不能挂在不存在的 provider 上（外键约束）', () => {
    expect(() =>
      mappings.upsert({ providerId: 'no-such-provider', fingerprint: 'fp-a', targetHost: 'h', targetPort: 1 }),
    ).toThrow();
  });
});
