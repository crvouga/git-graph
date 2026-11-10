// Accounts (one per auth-relay identity) and their linked GitHub account, in PostgreSQL.
//
// People are identified by the relay's (issuer, subject), never by email. A GitHub account is
// linked explicitly through the GitHub App's OAuth flow; its user-to-server tokens are stored
// encrypted (token-box.ts) so private repositories and live sync work from any device the person
// signs in on. One GitHub account links to at most one Lanes account.

import { AppError } from "../core/types.ts";
import { tokenIdentity } from "../github/client.ts";
import type { Db } from "./db.ts";
import type { TokenBox } from "./token-box.ts";

export interface GitHubTokens {
  accessToken: string;
  /** Unix ms; null for non-expiring OAuth App tokens. */
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: number | null;
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GitHubLinkInfo extends GitHubUser {
  linkedAt: number;
}

export interface GitHubLink extends GitHubLinkInfo {
  tokens: GitHubTokens;
  /** Optimistic-concurrency version for token updates. */
  version: number;
}

export interface Account {
  id: string;
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  github: GitHubLinkInfo | null;
}

export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
}

interface AccountRow {
  id: string;
  oidc_issuer: string;
  oidc_subject: string;
  email: string | null;
  name: string | null;
  picture: string | null;
  github_user_id: string | number | null;
  github_login: string | null;
  github_name: string | null;
  github_avatar_url: string | null;
  linked_at: Date | string | null;
}

interface LinkRow {
  github_user_id: string | number;
  github_login: string;
  github_name: string | null;
  github_avatar_url: string | null;
  linked_at: Date | string;
  access_token: string;
  access_token_expires_at: Date | string | null;
  refresh_token: string | null;
  refresh_token_expires_at: Date | string | null;
  version: number;
}

const ms = (v: Date | string | null): number | null => (v === null ? null : new Date(v).getTime());
const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 10_000;

export class AccountStore {
  private readonly db: Db;
  private readonly box: TokenBox;
  private readonly cache = new Map<string, { at: number; account: Account | null }>();

  constructor(db: Db, box: TokenBox) {
    this.db = db;
    this.box = box;
  }

  /** Find or create the account for a verified relay identity; refreshes its profile. */
  async signIn(id: OidcIdentity): Promise<Account> {
    const rows = await this.db.query<{ id: string }>(
      `insert into ${this.db.t("accounts")} (oidc_issuer, oidc_subject, email, name, picture)
       values ($1, $2, $3, $4, $5)
       on conflict (oidc_issuer, oidc_subject)
       do update set email = excluded.email, name = excluded.name, picture = excluded.picture, last_login_at = now()
       returning id`,
      [id.issuer, id.subject, id.email, id.name, id.picture],
    );
    this.cache.delete(rows[0]!.id);
    return (await this.get(rows[0]!.id))!;
  }

  /** The account and its GitHub link summary (cached briefly; writes here invalidate it). */
  async get(accountId: string): Promise<Account | null> {
    const hit = this.cache.get(accountId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.account;
    const rows = await this.db.query<AccountRow>(
      `select a.id, a.oidc_issuer, a.oidc_subject, a.email, a.name, a.picture,
              g.github_user_id, g.github_login, g.github_name, g.github_avatar_url, g.linked_at
       from ${this.db.t("accounts")} a
       left join ${this.db.t("github_links")} g on g.account_id = a.id
       where a.id = $1`,
      [accountId],
    );
    const r = rows[0];
    const account: Account | null = r
      ? {
          id: r.id,
          issuer: r.oidc_issuer,
          subject: r.oidc_subject,
          email: r.email,
          name: r.name,
          picture: r.picture,
          github:
            r.github_user_id === null
              ? null
              : { id: Number(r.github_user_id), login: r.github_login!, name: r.github_name, avatarUrl: r.github_avatar_url, linkedAt: ms(r.linked_at)! },
        }
      : null;
    this.cache.set(accountId, { at: Date.now(), account });
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return account;
  }

  /** The decrypted GitHub link, or null when none (or it can no longer be decrypted). */
  async githubLink(accountId: string): Promise<GitHubLink | null> {
    const rows = await this.db.query<LinkRow>(
      `select github_user_id, github_login, github_name, github_avatar_url, linked_at, access_token, access_token_expires_at,
              refresh_token, refresh_token_expires_at, version
       from ${this.db.t("github_links")} where account_id = $1`,
      [accountId],
    );
    const r = rows[0];
    if (!r) return null;
    let tokens: GitHubTokens;
    try {
      tokens = {
        accessToken: this.box.open(r.access_token, `${accountId}:access`),
        accessTokenExpiresAt: ms(r.access_token_expires_at),
        refreshToken: r.refresh_token === null ? null : this.box.open(r.refresh_token, `${accountId}:refresh`),
        refreshTokenExpiresAt: ms(r.refresh_token_expires_at),
      };
    } catch {
      return null; // key rotated or row tampered with: the person reconnects GitHub
    }
    return {
      id: Number(r.github_user_id),
      login: r.github_login,
      name: r.github_name,
      avatarUrl: r.github_avatar_url,
      linkedAt: ms(r.linked_at)!,
      tokens,
      version: Number(r.version),
    };
  }

  private sealTokens(accountId: string, t: GitHubTokens) {
    return [
      this.box.seal(t.accessToken, `${accountId}:access`),
      iso(t.accessTokenExpiresAt),
      t.refreshToken === null ? null : this.box.seal(t.refreshToken, `${accountId}:refresh`),
      iso(t.refreshTokenExpiresAt),
      tokenIdentity(t.accessToken),
    ] as const;
  }

  /** Link (or re-link) a GitHub account. CONFLICT when it is linked to another Lanes account. */
  async linkGitHub(accountId: string, user: GitHubUser, tokens: GitHubTokens): Promise<void> {
    const [access, accessExp, refresh, refreshExp, tid] = this.sealTokens(accountId, tokens);
    try {
      await this.db.query(
        `insert into ${this.db.t("github_links")}
           (account_id, github_user_id, github_login, github_name, github_avatar_url, token_id,
            access_token, access_token_expires_at, refresh_token, refresh_token_expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::timestamptz)
         on conflict (account_id) do update set
           github_user_id = excluded.github_user_id, github_login = excluded.github_login,
           github_name = excluded.github_name, github_avatar_url = excluded.github_avatar_url,
           token_id = excluded.token_id, access_token = excluded.access_token,
           access_token_expires_at = excluded.access_token_expires_at, refresh_token = excluded.refresh_token,
           refresh_token_expires_at = excluded.refresh_token_expires_at,
           version = ${this.db.t("github_links")}.version + 1, linked_at = now(), updated_at = now()`,
        [accountId, user.id, user.login, user.name, user.avatarUrl, tid, access, accessExp, refresh, refreshExp],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") {
        throw new AppError("CONFLICT", `GitHub account @${user.login} is already connected to another Lanes account; disconnect it there first`);
      }
      throw e;
    } finally {
      this.cache.delete(accountId);
    }
  }

  /** Store refreshed tokens if nobody else did first. False when the version moved on. */
  async updateTokens(accountId: string, version: number, tokens: GitHubTokens): Promise<boolean> {
    const [access, accessExp, refresh, refreshExp, tid] = this.sealTokens(accountId, tokens);
    const rows = await this.db.query(
      `update ${this.db.t("github_links")} set access_token = $3, access_token_expires_at = $4::timestamptz, refresh_token = $5,
         refresh_token_expires_at = $6::timestamptz, token_id = $7, version = version + 1, updated_at = now()
       where account_id = $1 and version = $2 returning account_id`,
      [accountId, version, access, accessExp, refresh, refreshExp, tid],
    );
    return rows.length > 0;
  }

  /** Remove this account's GitHub link; returns the GitHub user id it had. */
  async unlinkGitHub(accountId: string): Promise<number | null> {
    this.cache.delete(accountId);
    const rows = await this.db.query<{ github_user_id: string }>(`delete from ${this.db.t("github_links")} where account_id = $1 returning github_user_id`, [accountId]);
    return rows[0] ? Number(rows[0].github_user_id) : null;
  }

  /** The GitHub user revoked the App: forget their link (whichever account holds it). */
  async unlinkGitHubUser(githubUserId: number): Promise<void> {
    const rows = await this.db.query<{ account_id: string }>(`delete from ${this.db.t("github_links")} where github_user_id = $1 returning account_id`, [githubUserId]);
    for (const r of rows) this.cache.delete(r.account_id);
  }

  /** GitHub rejected this token: forget the links that use it. Returns their GitHub user ids. */
  async unlinkToken(tokenId: string): Promise<number[]> {
    const rows = await this.db.query<{ account_id: string; github_user_id: string }>(
      `delete from ${this.db.t("github_links")} where token_id = $1 returning account_id, github_user_id`,
      [tokenId],
    );
    for (const r of rows) this.cache.delete(r.account_id);
    return rows.map((r) => Number(r.github_user_id));
  }
}
