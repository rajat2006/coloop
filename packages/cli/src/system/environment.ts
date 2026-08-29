export const sanitizedSubprocessEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  // Codex, browser helpers, and child Coloop processes do not need provider secrets.
  delete environment.DISCORD_TOKEN;
  delete environment.OPENAI_API_KEY;
  return environment;
};
