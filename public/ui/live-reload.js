const updates = new EventSource("/ui-live-reload");

updates.addEventListener("message", () => window.location.reload());
