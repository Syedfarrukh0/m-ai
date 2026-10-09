// M.Ai web chat. Everything shown is set as text, never as HTML.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var log = $('log');
  var busy = false;

  var TIPS = ['aaj ki sale kitni hui?', 'kis kis ka udhaar baqi hai?', 'bank mein kitna paisa hai?', 'آج کی سیل کتنی ہوئی؟'];

  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  var conversationId = (function () {
    try { var v = sessionStorage.getItem('m-ai-conversation'); if (v) return v; } catch (e) { /* no storage */ }
    return newId();
  })();
  function keepConversation() { try { sessionStorage.setItem('m-ai-conversation', conversationId); } catch (e) { /* no storage */ } }
  keepConversation();

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { status: res.status, data: data }; });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function scroll() { log.scrollTop = log.scrollHeight; }

  function showSignedIn(me) {
    $('signin').style.display = 'none';
    $('chat').style.display = 'flex';
    $('who').textContent = me.name + ' · ' + me.company;
    $('newchat').hidden = false;
    $('signout').hidden = false;
    if (!log.children.length) showEmpty();
    $('text').focus();
  }

  function showSignedOut() {
    $('signin').style.display = 'block';
    $('chat').style.display = 'none';
    $('who').textContent = '';
    $('newchat').hidden = true;
    $('signout').hidden = true;
  }

  function showEmpty() {
    log.textContent = '';
    log.appendChild(el('div', 'empty', 'Apne business ke baare mein kuch bhi poochein — Urdu, Roman Urdu ya English mein.'));
    var tips = $('tips');
    tips.textContent = '';
    TIPS.forEach(function (t) {
      var b = el('button', '', t);
      b.type = 'button';
      b.dir = 'auto';
      b.onclick = function () { send(t); };
      tips.appendChild(b);
    });
  }

  function clearEmpty() {
    var e = log.querySelector('.empty');
    if (e) e.remove();
    $('tips').textContent = '';
  }

  function addMine(text) {
    clearEmpty();
    var m = el('div', 'msg me', text);
    m.dir = 'auto';
    log.appendChild(m);
    scroll();
  }

  function addReply(v) {
    var m = el('div', 'msg ai' + (v.status === 'unavailable' ? ' unavailable' : ''));
    var body = el('div', '', v.reply);
    body.dir = 'auto';
    m.appendChild(body);
    (v.documents || []).forEach(function (d) {
      var a = el('a', 'file', '📄 ' + (d.fileName || 'PDF'));
      a.href = '/v1/pilot/documents/' + encodeURIComponent(d.documentId);
      a.target = '_blank';
      a.rel = 'noopener';
      m.appendChild(a);
    });
    if (v.pending && v.pending.options) {
      var row = el('div', 'choices');
      v.pending.options.forEach(function (o) {
        var b = el('button', o.value === 'yes' ? 'primary' : '', o.label);
        b.type = 'button';
        b.onclick = function () {
          Array.prototype.forEach.call(row.querySelectorAll('button'), function (x) { x.disabled = true; });
          send(o.label, o.value);
        };
        row.appendChild(b);
      });
      m.appendChild(row);
    }
    var meta = [];
    if (v.usage && v.usage.model) meta.push(v.usage.model.replace(/^.*\//, ''));
    if (v.usage && v.usage.charge) meta.push(v.usage.charge.currency + ' ' + v.usage.charge.amount);
    if (meta.length) m.appendChild(el('div', 'meta', meta.join(' · ')));
    log.appendChild(m);
    scroll();
  }

  function addNote(text) {
    var m = el('div', 'msg ai unavailable', text);
    log.appendChild(m);
    scroll();
  }

  function send(text, choice) {
    if (busy || !text.trim()) return;
    busy = true;
    $('send').disabled = true;
    addMine(text);
    var typing = el('div', 'msg ai typing', 'M.Ai likh raha hai…');
    log.appendChild(typing);
    scroll();
    var body = { conversationId: conversationId, text: text };
    if (choice) body.choice = choice;
    api('POST', '/v1/pilot/turn', body).then(function (r) {
      typing.remove();
      if (r.status === 401) { addNote('Session khatam ho gaya. Dobara sign in karein.'); showSignedOut(); return; }
      if (r.status !== 200) { addNote(r.data.error || 'Kuch masla hua. Thori der baad koshish karein.'); return; }
      addReply(r.data);
    }).catch(function () {
      typing.remove();
      addNote('M.Ai tak rabta nahi ho saka. Internet check karein.');
    }).then(function () {
      busy = false;
      $('send').disabled = false;
      $('text').focus();
    });
  }

  $('signin').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('signin-error').textContent = '';
    var btn = $('signin').querySelector('button');
    btn.disabled = true;
    api('POST', '/v1/pilot/sign-in', { tenantCode: $('tenant').value.trim(), email: $('email').value.trim(), password: $('password').value })
      .then(function (r) {
        $('password').value = '';
        if (r.status !== 200) { $('signin-error').textContent = r.data.error || 'Sign in nahi ho saka.'; return; }
        showSignedIn(r.data);
      })
      .catch(function () { $('signin-error').textContent = 'M.Ai tak rabta nahi ho saka.'; })
      .then(function () { btn.disabled = false; });
  });

  $('say').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var t = $('text').value;
    $('text').value = '';
    send(t);
  });
  $('text').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); $('say').requestSubmit(); }
  });

  $('newchat').onclick = function () {
    conversationId = newId();
    keepConversation();
    showEmpty();
    $('text').focus();
  };
  $('signout').onclick = function () {
    api('POST', '/v1/pilot/sign-out').then(function () { log.textContent = ''; showSignedOut(); });
  };

  // Start: already signed in? Otherwise the sign-in form, with the company code filled in.
  api('GET', '/v1/info').then(function (r) {
    if (r.data && r.data.pilot) $('tenant').value = r.data.pilot.tenantCode;
    else $('signin-error').textContent = 'Is server par pilot sign-in band hai.';
  });
  api('GET', '/v1/pilot/me').then(function (r) { if (r.status === 200) showSignedIn(r.data); else showSignedOut(); });
})();
