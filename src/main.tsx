import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/app";
import { initPlatform } from "@/lib/platform";

const root = ReactDOM.createRoot(
  document.getElementById("root") as HTMLElement
);

initPlatform()
  .then(() => {
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    root.render(
      <p style={{ padding: "2rem", fontFamily: "system-ui" }}>
        Leaflet could not start in this browser:{" "}
        {error instanceof Error ? error.message : String(error)}
      </p>
    );
  });
