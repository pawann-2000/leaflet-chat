import { Button } from "@/components/ui/button";
import {
  ErrorActions,
  ErrorDescription,
  ErrorHeader,
  ErrorView,
} from "@/features/errors/error-base";
import { isDesktopHost } from "@/lib/platform";

async function restart() {
  if (isDesktopHost) {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
    return;
  }
  location.reload();
}

export default function AppErrorPage() {
  return (
    <ErrorView>
      <ErrorHeader>We&apos;re fixing it</ErrorHeader>
      <ErrorDescription>
        The app encountered an error and needs to be restarted.
        <br />
        We know about it and we&apos;re working to fix it.
      </ErrorDescription>
      <ErrorActions>
        <Button onClick={restart} size="lg">
          {isDesktopHost ? "Relaunch app" : "Reload"}
        </Button>
      </ErrorActions>
    </ErrorView>
  );
}
