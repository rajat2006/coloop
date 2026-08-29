import type { ColoopDependencies } from "../dependencies.js";
import { checkReadiness } from "../readiness.js";
import { Terminal } from "../terminal/terminal.js";
import { recordTelemetry } from "../telemetry.js";

export const runRuntime = async (
  dependencies: ColoopDependencies,
  terminal: Terminal,
  environment: NodeJS.ProcessEnv,
): Promise<void> => {
  terminal.line("Coloop runtime startup");
  // Runtime startup is validation-only; all repair and selection belongs to setup.
  const readiness = await checkReadiness(dependencies, environment);
  if (!readiness.ok) {
    recordTelemetry(dependencies, {
      schemaVersion: 1,
      stream: "product",
      name: "setup.readiness",
      occurredAt: new Date().toISOString(),
      attributes: { result: "failed", check: "configuration" },
    });
    throw new Error(readiness.message);
  }
  recordTelemetry(dependencies, {
    schemaVersion: 1,
    stream: "product",
    name: "setup.readiness",
    occurredAt: new Date().toISOString(),
    attributes: { result: "succeeded", check: "configuration" },
  });
  terminal.line("Readiness check passed.");

  // Do not connect Discord until every local and remote readiness check has passed.
  const gateway = await dependencies.discord.connectGateway(
    readiness.value.discordToken,
  );
  if (!gateway.ok) {
    throw new Error("Discord Gateway startup failed.");
  }
  terminal.line(
    `Coloop is running in the foreground for ${readiness.value.guild.name}/#${readiness.value.channel.name}.`,
  );
  try {
    await dependencies.waitForShutdown();
  } finally {
    // Always release the Gateway connection when the foreground wait ends.
    await gateway.value.close();
  }
};
