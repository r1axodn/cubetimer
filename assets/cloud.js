/* cloud.js — Supabase 이메일 로그인과 기록 클라우드 백업.
 *
 * 설계 원칙
 *  - 로그인하지 않았거나 SDK/CDN이 없으면 아무 것도 하지 않는다. 타이머는 늘 그대로 동작한다.
 *  - 로그인 상태의 기록 저장은 localStorage에 먼저 쓰고, 2.5초 디바운스로 user_backups 한 행을 upsert.
 *  - 서버에 테이블이 없어도(404 / 42P01 / PGRST205) 예외를 밖으로 던지지 않고 상태만 'setup'으로 알린다.
 */
(function () {
  'use strict';

  var SUPABASE_URL = 'https://vipaohlgodyrbjnsewuo.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_pl28DHu3fwfqU-Nw92hyPg_nLcdeJaS';
  var TABLE = 'user_backups';
  var DEBOUNCE_MS = 2500;

  var cfg = null;
  var client = null;
  var sdkProblem = null;
  var user = null;
  var status = 'off';          // off | syncing | saving | synced | offline | setup | error
  var statusDetail = '';
  var pushTimer = 0;
  var pushInFlight = null;
  var pushAgain = false;
  var lastUserId = null;
  var reconcileToken = 0;
  var announcedSetup = false;

  /* ---------------- 상태 알림 ---------------- */

  function emit() {
    if (cfg && typeof cfg.onStatus === 'function') {
      try { cfg.onStatus(status, statusDetail); } catch (err) { /* UI 문제로 동기화를 멈추지 않는다 */ }
    }
  }

  function setStatus(next, detail) {
    var changed = next !== status || (detail || '') !== (statusDetail || '');
    status = next;
    statusDetail = detail || '';
    if (changed) emit();
  }

  function notify(text) {
    if (cfg && typeof cfg.onNotice === 'function') {
      try { cfg.onNotice(text); } catch (err) { /* ignore */ }
    }
  }

  /* ---------------- 오류 판별 ---------------- */

  function errText(err) {
    if (!err) return '';
    return [err.message, err.error_description, err.msg, err.details, err.hint, err.code, err.error_code]
      .filter(function (v) { return v; }).join(' ');
  }

  function isMissingTable(err) {
    if (!err) return false;
    var code = String(err.code || err.error_code || '');
    if (code === '42P01' || code === 'PGRST205' || code === 'PGRST204') return true;
    if (Number(err.status) === 404) return true;
    var text = errText(err).toLowerCase();
    return /could not find the table|relation .* does not exist|does not exist|schema cache/.test(text);
  }

  function isPermission(err) {
    if (!err) return false;
    var code = String(err.code || err.error_code || '');
    if (code === '42501') return true;
    return /row-level security|permission denied/.test(errText(err).toLowerCase());
  }

  function isNetwork(err) {
    if (!err) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    if (Number(err.status) === 0) return true;
    return /failed to fetch|networkerror|load failed|fetch failed|network request failed|timed? ?out/.test(errText(err).toLowerCase());
  }

  function handleSyncError(err) {
    if (isMissingTable(err)) {
      setStatus('setup', 'table');
      if (!announcedSetup) {
        announcedSetup = true;
        notify('DB 테이블 설정이 필요해요. Supabase에서 SQL을 실행하면 자동 백업이 시작됩니다.');
      }
      return;
    }
    if (isPermission(err)) {
      setStatus('setup', 'policy');
      if (!announcedSetup) {
        announcedSetup = true;
        notify('DB 접근 권한(RLS) 설정이 필요해요. Supabase에서 SQL을 실행해 주세요.');
      }
      return;
    }
    if (isNetwork(err)) { setStatus('offline'); return; }
    setStatus('error', errText(err).slice(0, 200));
  }

  /* ---------------- 페이로드 병합 ---------------- */

  function countSolves(payload) {
    var total = 0;
    if (!payload || !payload.sessions) return 0;
    Object.keys(payload.sessions).forEach(function (ev) {
      var bucket = payload.sessions[ev];
      if (!bucket || !Array.isArray(bucket.list)) return;
      bucket.list.forEach(function (s) {
        if (s && Array.isArray(s.solves)) total += s.solves.length;
      });
    });
    return total;
  }

  function cleanSolve(sv) {
    return {
      id: sv.id,
      ms: Number(sv.ms) || 0,
      penalty: sv.penalty === 'DNF' || sv.penalty === '+2' ? sv.penalty : null,
      scramble: typeof sv.scramble === 'string' ? sv.scramble : '',
      ts: Number(sv.ts) || 0
    };
  }

  /* 한 세션 안의 솔빙을 id 기준으로 합친다. 같은 id는 이 브라우저(로컬) 사본을 남긴다. */
  function mergeBucket(localB, remoteB) {
    var order = [];
    var byId = {};
    var seen = {};

    function addSolve(target, sv) {
      if (!sv || !sv.id) return;
      var key = target.id + '\u0000' + sv.id;
      if (seen[key]) return;
      seen[key] = true;
      target.solves.push(cleanSolve(sv));
    }

    function take(list) {
      (Array.isArray(list) ? list : []).forEach(function (s) {
        if (!s || !s.id) return;
        var id = String(s.id);
        var target = byId[id];
        if (!target) {
          target = { id: s.id, name: s.name || '세션', solves: [] };
          byId[id] = target;
          order.push(id);
        } else if ((!target.name || target.name === '세션') && s.name) {
          target.name = s.name;
        }
        (Array.isArray(s.solves) ? s.solves : []).forEach(function (sv) { addSolve(target, sv); });
      });
    }

    take(localB && localB.list);
    take(remoteB && remoteB.list);

    var list = order.map(function (id) {
      var s = byId[id];
      s.solves.sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
      return { id: s.id, name: s.name || '세션', solves: s.solves };
    });

    var active = null;
    if (localB && localB.active && byId[String(localB.active)]) active = localB.active;
    else if (remoteB && remoteB.active && byId[String(remoteB.active)]) active = remoteB.active;
    else if (list.length) active = list[0].id;

    return { active: active, list: list };
  }

  function mergePayload(local, remote) {
    local = local && typeof local === 'object' ? local : {};
    remote = remote && typeof remote === 'object' ? remote : {};
    var localSessions = local.sessions && typeof local.sessions === 'object' ? local.sessions : {};
    var remoteSessions = remote.sessions && typeof remote.sessions === 'object' ? remote.sessions : {};

    var out = {
      version: 1,
      updatedAt: new Date().toISOString(),
      event: local.event || remote.event || '333',
      settings: (remote.settings && countSolves(local) === 0) ? remote.settings : (local.settings || remote.settings || null),
      sessions: {}
    };

    var events = {};
    Object.keys(localSessions).forEach(function (ev) { events[ev] = true; });
    Object.keys(remoteSessions).forEach(function (ev) { events[ev] = true; });
    Object.keys(events).forEach(function (ev) {
      out.sessions[ev] = mergeBucket(localSessions[ev], remoteSessions[ev]);
    });

    return out;
  }

  /* ---------------- 읽기/쓰기 ---------------- */

  function readLocal() {
    try {
      var payload = cfg && typeof cfg.getPayload === 'function' ? cfg.getPayload() : null;
      if (payload && typeof payload === 'object') return payload;
    } catch (err) { /* ignore */ }
    return { version: 1, sessions: {} };
  }

  function applyLocal(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (cfg && typeof cfg.applyPayload === 'function') {
      try { cfg.applyPayload(payload); } catch (err) { /* ignore */ }
    }
  }

  async function doPush() {
    if (!user || !client) return false;
    var payload = readLocal();
    var stamp = new Date().toISOString();
    try {
      var res = await client.from(TABLE).upsert(
        { user_id: user.id, payload: payload, updated_at: stamp },
        { onConflict: 'user_id' }
      );
      if (res && res.error) { handleSyncError(res.error); return false; }
      setStatus('synced', stamp);
      return true;
    } catch (err) {
      handleSyncError(err);
      return false;
    }
  }

  function flush() {
    if (!user || !client) return Promise.resolve(false);
    clearTimeout(pushTimer);
    pushTimer = 0;
    if (pushInFlight) {
      pushAgain = true;
      return pushInFlight;
    }
    pushInFlight = doPush().then(function (ok) {
      pushInFlight = null;
      if (pushAgain) {
        pushAgain = false;
        if (ok) return flush();
      }
      return ok;
    }, function () {
      pushInFlight = null;
      return false;
    });
    return pushInFlight;
  }

  function schedulePush() {
    if (!user || !client) return;
    // 테이블/권한/연결 문제로 이미 실패 중이면 그 상태를 유지하고, 성공하면 synced로 바뀐다.
    if (status !== 'setup' && status !== 'offline') setStatus('saving');
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { flush(); }, DEBOUNCE_MS);
  }

  /* 로그인 직후 1회: 서버 사본을 읽어 병합하고, 병합 결과를 양쪽에 반영한다. */
  async function reconcile(session) {
    var token = ++reconcileToken;
    var local = readLocal();
    var remote = null;
    var readError = null;

    try {
      var res = await client.from(TABLE).select('payload').eq('user_id', session.user.id).maybeSingle();
      if (res && res.error) readError = res.error;
      else remote = res && res.data ? res.data.payload : null;
    } catch (err) {
      readError = err;
    }

    if (token !== reconcileToken) return;   // 더 새로운 로그인/로그아웃이 이 reconcile을 대체했다

    if (readError) {
      handleSyncError(readError);
      return;
    }

    if (remote && typeof remote === 'object') {
      applyLocal(mergePayload(local, remote));
    }

    await flush();
  }

  /* ---------------- 인증 ---------------- */

  function clearTimers() {
    clearTimeout(pushTimer);
    pushTimer = 0;
    pushAgain = false;
  }

  function handleSignedIn(session) {
    var u = session && session.user;
    if (!u) return;
    var wasSame = lastUserId === u.id;
    user = u;
    if (wasSame && (status === 'syncing' || status === 'synced' || status === 'saving')) {
      emit();
      return;
    }
    lastUserId = u.id;
    setStatus('syncing');
    reconcile(session);
  }

  function handleSignedOut() {
    reconcileToken++;
    user = null;
    lastUserId = null;
    clearTimers();
    setStatus('off');
  }

  function sdkError() {
    return { code: 'sdk_unavailable', message: sdkProblem || '백업 기능을 불러오지 못했습니다.' };
  }

  async function signIn(email, password) {
    if (!client) return { error: sdkError() };
    try {
      var res = await client.auth.signInWithPassword({ email: email, password: password });
      if (res && res.error) return { error: res.error };
      var session = res && res.data ? res.data.session : null;
      if (!session) return { error: { code: 'no_session', message: '로그인 세션을 받지 못했습니다.' } };
      handleSignedIn(session);
      return { ok: true };
    } catch (err) {
      return { error: err };
    }
  }

  async function signUp(email, password) {
    if (!client) return { error: sdkError() };
    try {
      var res = await client.auth.signUp({
        email: email,
        password: password,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });
      if (res && res.error) return { error: res.error };
      var session = res && res.data ? res.data.session : null;
      if (session) {
        handleSignedIn(session);
        return { ok: true, pendingConfirm: false };
      }
      return { ok: true, pendingConfirm: true };
    } catch (err) {
      return { error: err };
    }
  }

  async function signOut() {
    reconcileToken++;
    try {
      if (client) await client.auth.signOut({ scope: 'local' });
    } catch (err) { /* 세션이 이미 없어도 로컬 상태는 초기화한다 */ }
    handleSignedOut();
    return { ok: true };
  }

  /* ---------------- 초기화 ---------------- */

  function init(opts) {
    cfg = opts || {};

    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      sdkProblem = 'SDK를 불러오지 못했습니다.';
      setStatus('off', 'sdk');
      return;
    }

    try {
      client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
    } catch (err) {
      client = null;
      sdkProblem = err && err.message ? err.message : 'SDK 초기화 실패';
      setStatus('off', 'sdk');
      return;
    }

    client.auth.onAuthStateChange(function (event, session) {
      // 콜백 안에서 네트워크를 기다리면 인증 흐름이 막힌다. 다음 틱으로 넘긴다.
      setTimeout(function () {
        if (event === 'SIGNED_OUT') { handleSignedOut(); return; }
        if (session && session.user) handleSignedIn(session);
      }, 0);
    });

    try {
      client.auth.getSession().then(function (res) {
        var session = res && res.data ? res.data.session : null;
        if (session && session.user) handleSignedIn(session);
      }, function () { /* 저장된 세션 없음 */ });
    } catch (err) { /* ignore */ }

    window.addEventListener('online', function () {
      if (!user) return;
      if (status === 'offline' || status === 'error') flush();
      else if (pushTimer) flush();
    });

    window.addEventListener('offline', function () {
      if (user) setStatus('offline');
    });

    // 탭을 닫거나 가릴 때 대기 중인 저장을 바로 보낸다 (2.5초 디바운스 유실 방지).
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && pushTimer) flush();
    });
    window.addEventListener('pagehide', function () {
      if (pushTimer) flush();
    });

    emit();
  }

  window.CubeCloud = {
    init: init,
    hasSdk: function () { return !!client; },
    user: function () { return user ? { id: user.id, email: user.email } : null; },
    status: function () { return status; },
    statusDetail: function () { return statusDetail; },
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    backupNow: function () { return flush(); },
    notifyLocalChange: schedulePush,
    mergePayload: mergePayload
  };
})();
