/* Static demo mode: answers the UI's API calls with precomputed data. */
(function () {
  const D = window.DEMO_DATA;
  const originalFetch = window.fetch.bind(window);

  function json(obj) {
    return Promise.resolve(new Response(JSON.stringify(obj), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
  }

  function csv(text) {
    return Promise.resolve(new Response(text, {
      status: 200,
      headers: { "Content-Type": "text/csv" }
    }));
  }

  function pathOf(input) {
    const raw = typeof input === "string" ? input : (input && input.url) || "";
    try {
      return new URL(raw, window.location.href).pathname;
    } catch (e) {
      return raw;
    }
  }

  window.fetch = function (input, init) {
    const path = pathOf(input);

    if (path === "/samples") return json(D.samples);
    if (path === "/samples/1") return json(D.sample1);
    if (path === "/samples/2") return json(D.sample2);
    if (path === "/samples/3") return json(D.sample3);

    if (path === "/score") {
      let resume = "";
      try {
        if (init && init.body && init.body.get) {
          resume = init.body.get("resume_text") || "";
        }
      } catch (e) { /* ignore */ }
      if (resume.indexOf("Electrical Engineer") !== -1) return json(D.score2);
      if (resume.indexOf("BI developer") !== -1) return json(D.score3);
      return json(D.score1);
    }

    if (path === "/rank") return json(D.rank);
    if (path === "/api/related-jobs") return json(D.related);

    if (path === "/export") {
      const rows = [["Rank", "Resume", "Fit Score", "Fit Label"]]
        .concat(D.rank.results.map(r => [r.rank, r.name, r.score, r.label]));
      return csv(rows.map(r => r.join(",")).join("\n"));
    }

    return originalFetch(input, init);
  };
})();
