import { randomUUID } from 'node:crypto';
import { safeEqual } from '../../core/auth-crypto.js';
import type { Db } from '../index.js';

export interface OAuthAttemptInput {
  tokenHash: string;
  stateHash: string;
  nonce: string;
  codeVerifierEnc: string;
  expiresAt: number;
  createdAt: number;
}

export interface OAuthAttempt {
  nonce: string;
  codeVerifierEnc: string;
}

export interface GoogleAccountInput {
  googleSub: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  now: number;
}

export interface AuthenticatedSession {
  sessionId: string;
  accountId: string;
  googleSub: string;
  email: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
  csrfHash: string;
  expiresAt: number;
  lastSeenAt: number;
}

interface OAuthAttemptRow {
  state_hash: string;
  nonce: string;
  code_verifier_enc: string;
  expires_at: number;
}

interface SessionRow {
  session_id: string;
  account_id: string;
  google_sub: string;
  email: string;
  email_verified: number;
  display_name: string;
  avatar_url: string | null;
  csrf_hash: string;
  expires_at: number;
  last_seen_at: number;
}

export class AuthRepo {
  constructor(private readonly db: Db) {}

  createOAuthAttempt(input: OAuthAttemptInput): void {
    this.db.prepare(`
      INSERT INTO oauth_login_attempts (
        token_hash, state_hash, nonce, code_verifier_enc, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.tokenHash,
      input.stateHash,
      input.nonce,
      input.codeVerifierEnc,
      input.expiresAt,
      input.createdAt,
    );
  }

  /** Consume the attempt even on a bad state so neither mistakes nor replays remain usable. */
  consumeOAuthAttempt(tokenHash: string, stateHash: string, now: number): OAuthAttempt | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT state_hash, nonce, code_verifier_enc, expires_at
        FROM oauth_login_attempts
        WHERE token_hash = ? AND used_at IS NULL
      `).get(tokenHash) as OAuthAttemptRow | undefined;

      if (!row) return null;
      this.db.prepare('UPDATE oauth_login_attempts SET used_at = ? WHERE token_hash = ?').run(now, tokenHash);
      if (row.expires_at <= now || !safeEqual(row.state_hash, stateHash)) return null;
      return { nonce: row.nonce, codeVerifierEnc: row.code_verifier_enc };
    })();
  }

  upsertGoogleAccount(input: GoogleAccountInput): string {
    const existing = this.db.prepare(
      'SELECT id FROM google_accounts WHERE google_sub = ?',
    ).get(input.googleSub) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE google_accounts
        SET email = ?, email_verified = 1, display_name = ?, avatar_url = ?, last_login_at = ?
        WHERE id = ?
      `).run(input.email, input.displayName, input.avatarUrl, input.now, existing.id);
      return existing.id;
    }

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO google_accounts (
        id, google_sub, email, email_verified, display_name, avatar_url, created_at, last_login_at
      ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id,
      input.googleSub,
      input.email,
      input.displayName,
      input.avatarUrl,
      input.now,
      input.now,
    );
    return id;
  }

  createSession(input: {
    accountId: string;
    tokenHash: string;
    csrfHash: string;
    expiresAt: number;
    now: number;
  }): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO web_sessions (
        id, account_id, token_hash, csrf_hash, expires_at, created_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.accountId,
      input.tokenHash,
      input.csrfHash,
      input.expiresAt,
      input.now,
      input.now,
    );
    return id;
  }

  getSession(tokenHash: string, now: number): AuthenticatedSession | null {
    const row = this.db.prepare(`
      SELECT
        s.id AS session_id,
        s.account_id,
        a.google_sub,
        a.email,
        a.email_verified,
        a.display_name,
        a.avatar_url,
        s.csrf_hash,
        s.expires_at,
        s.last_seen_at
      FROM web_sessions s
      JOIN google_accounts a ON a.id = s.account_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
    `).get(tokenHash, now) as SessionRow | undefined;

    if (!row) return null;
    return {
      sessionId: row.session_id,
      accountId: row.account_id,
      googleSub: row.google_sub,
      email: row.email,
      emailVerified: row.email_verified === 1,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      csrfHash: row.csrf_hash,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  touchSession(sessionId: string, now: number): void {
    this.db.prepare('UPDATE web_sessions SET last_seen_at = ? WHERE id = ?').run(now, sessionId);
  }

  revokeSession(tokenHash: string, now: number): boolean {
    return this.db.prepare(`
      UPDATE web_sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(now, tokenHash).changes > 0;
  }

  prune(now: number): void {
    this.db.prepare('DELETE FROM oauth_login_attempts WHERE expires_at <= ? OR used_at IS NOT NULL').run(now);
    this.db.prepare('DELETE FROM web_sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL').run(now);
  }

  counts(): { accounts: number; sessions: number; attempts: number } {
    const count = (table: string): number => (
      this.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }
    ).value;
    return {
      accounts: count('google_accounts'),
      sessions: count('web_sessions'),
      attempts: count('oauth_login_attempts'),
    };
  }
}
