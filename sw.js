/* SplitWisely — service worker
   Estratégia: stale-while-revalidate para os ficheiros da app — responde já
   da cache (arranque instantâneo, também offline) e revalida em segundo
   plano. Quando o ficheiro no servidor mudou, avisa as páginas abertas para
   recarregarem, por isso a versão nova continua a entrar sozinha — mas sem
   pagar o download da app inteira (~700 kB) em cada arranque, como acontecia
   com o network-first + `cache: "no-store"` de antes.
   Pedidos a outras origens (API do Supabase) passam direto, sem cache. */
"use strict";

const CACHE = "splitwisely-v20";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./vendor/supabase.js",
  "./icons/icon-192.png",
  "./icons/icon-splash.webp",
  "./icons/icon-mark.webp",
];

// Ficheiros cuja mudança justifica recarregar a página aberta (o resto —
// ícones, manifest — entra em silêncio no arranque seguinte).
const CODE = ["./index.html", "./app.js", "./styles.css", "./vendor/supabase.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Assinatura da resposta, para saber se o ficheiro mudou. O GitHub Pages
// manda ETag; o Last-Modified e o tamanho ficam como alternativa. Sem
// nenhum dos três não dá para comparar — não avisamos ninguém e a versão
// nova (que fica já gravada na cache) entra no arranque seguinte.
function stamp(res) {
  return res.headers.get("etag")
    || res.headers.get("last-modified")
    || res.headers.get("content-length")
    || "";
}

async function notifyUpdate() {
  const clients = await self.clients.matchAll({ type: "window" });
  for (const c of clients) c.postMessage({ type: "update-ready" });
}

// Revalida um pedido contra o servidor e atualiza a cache. Usa
// `cache: "no-cache"` (e não "no-store"): força a validação com o servidor
// — nunca serve do max-age do browser — mas deixa-o responder 304 quando o
// ficheiro não mudou, que é o caso quase sempre e custa uns bytes.
async function revalidate(req, cached) {
  let res;
  try {
    res = await fetch(req, { cache: "no-cache" });
  } catch (_) {
    return null;                      // offline: fica o que está em cache
  }
  if (!res.ok) return res;

  const before = cached ? stamp(cached) : "";
  const after = stamp(res);
  const cache = await caches.open(CACHE);
  await cache.put(req, res.clone());

  if (before && after && before !== after) {
    const path = new URL(req.url).pathname;
    if (CODE.some((f) => path.endsWith(f.slice(1)))) await notifyUpdate();
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) {
        // responde já e revalida à parte, sem segurar a página
        e.waitUntil(revalidate(e.request, cached));
        return cached;
      }
      // 1.ª visita (ou ficheiro fora da shell): rede, com a cache como rede
      // de segurança para as navegações offline
      return revalidate(e.request, null).then((res) =>
        (res && res.ok)
          ? res
          : caches.match(e.request).then((hit) =>
              hit || (e.request.mode === "navigate" ? caches.match("./index.html") : Response.error())
            )
      );
    })
  );
});

// Notificações push (despesa nova que afeta alguém que não a lançou) — a
// Edge Function push-notificar-splitwisely manda um payload
// {title, body, url}; aqui só se mostra a notificação.
self.addEventListener("push", (e) => {
  let data = { title: "SplitWisely", body: "Tens uma novidade na app.", url: "./" };
  try { Object.assign(data, e.data.json()); } catch (_) { /* payload vazio ou não-JSON */ }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: data.url || "./" },
    })
  );
});

// Clique na notificação: foca uma janela já aberta da app, ou abre uma nova.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.startsWith(self.registration.scope) && "focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});

// A página pede-nos uma verificação (ao arrancar, ao voltar a ficar visível e
// de tempos a tempos): revalidamos só o código, para apanhar versões novas
// enquanto a app está aberta.
self.addEventListener("message", (e) => {
  if (e.data?.type !== "check-update") return;
  e.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      for (const f of CODE) {
        const req = new Request(new URL(f, self.registration.scope).href);
        const cached = await cache.match(req);
        await revalidate(req, cached);
      }
    })
  );
});
