import { execFile } from "node:child_process";
import { sanitizedSubprocessEnvironment } from "./environment.js";

export const openExternal = async (url: string): Promise<void> => {
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  await new Promise<void>((resolve, reject) => {
    execFile(
      command.executable,
      command.args,
      { env: sanitizedSubprocessEnvironment() },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
};
