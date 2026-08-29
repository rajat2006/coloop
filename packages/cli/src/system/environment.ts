export const sanitizedSubprocessEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.DISCORD_TOKEN;
  delete environment.OPENAI_API_KEY;
  return environment;
};
