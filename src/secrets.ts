/**
 * 建连接时顺手填的密码 / 密码短语，在这儿中转一下。
 *
 * 为什么不直接存钥匙串：钥匙串里那条是「认证过的凭据」，
 * 密码没试过就存进去，打错一个字母以后每次都拿错的去连（还可能撞锁账号）。
 * 所以先在内存里放着，交给那条会话去连；连上了再由 Rust 侧写进钥匙串。
 *
 * 只在内存里，不落盘、不进 localStorage，窗口一关就没了。
 */
export interface PendingSecret {
  secret: string;
  /** 连上之后要不要记进系统钥匙串 */
  remember: boolean;
}

const box = new Map<string, PendingSecret>();

/** 配置页填完了，放这儿等会话来取 */
export function stashSecret(connId: string, pending: PendingSecret): void {
  box.set(connId, pending);
}

/** 会话取走：取一次就没了，别在内存里多留 */
export function takeSecret(connId: string): PendingSecret | undefined {
  const one = box.get(connId);
  box.delete(connId);
  return one;
}

/** 连接被删了，顺手把没人认领的那份清掉 */
export function dropSecret(connId: string): void {
  box.delete(connId);
}
