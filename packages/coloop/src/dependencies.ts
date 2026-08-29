export interface DiscordApplication {
  id: string;
  messageContentIntentEnabled: boolean;
  name: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export interface DiscordChannel {
  guildId: string;
  id: string;
  name: string;
  permissions: string;
  type: "GUILD_TEXT" | "OTHER";
}

export interface DiscordMember {
  displayName: string;
  id: string;
  username: string;
}

export interface DiscordProvider {
  connectGateway(token: string): Promise<{ close(): Promise<void> }>;
  getApplication(token: string): Promise<DiscordApplication>;
  listChannels(token: string, guildId: string): Promise<DiscordChannel[]>;
  listGuilds(token: string): Promise<DiscordGuild[]>;
  resolveMember(
    token: string,
    guildId: string,
    userId: string,
  ): Promise<DiscordMember | null>;
}

export interface OpenAIProvider {
  validateCredential(apiKey: string): Promise<void>;
}

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface CommandInvocation {
  args: string[];
  command: string;
}

export class CredentialRejectedError extends Error {
  constructor() {
    super("provider_credential_rejected");
    this.name = "CredentialRejectedError";
  }
}

export const isCredentialRejectedError = (
  error: unknown,
): error is CredentialRejectedError => error instanceof CredentialRejectedError;

export interface ColoopDependencies {
  coloopEntrypoint: CommandInvocation;
  discord: DiscordProvider;
  openExternal(url: string): Promise<void>;
  openai: OpenAIProvider;
  runCodex(args: string[]): Promise<CommandResult>;
  runColoop(args: string[], input: string): Promise<CommandResult>;
  waitForShutdown(): Promise<void>;
}
