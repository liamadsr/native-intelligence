/*
 * Native Intelligence forms: draw a public form on a business's own site.
 *
 *   <div data-ni-form="fk_..."></div>
 *   <script async src="https://<app>/f/embed.js"></script>
 *
 * Finds every [data-ni-form], reads the form's shape (and, when the form asks
 * for the bot check, a challenge) from this script's own origin, draws a
 * plain form in the page's own font, works the challenge, posts what was
 * typed as JSON and shows the thank-you line or the error. A form that takes
 * files (a field of type 'file') posts its fields and its files together as
 * multipart form data instead, after the same checks the form's own page
 * makes (how many, how large, what kind by name): the server checks each
 * file again, by its bytes too.
 *
 * Plain ES2017, no build step, no dependencies. Everything the network sends
 * (labels, options, lines) is set as text, never as HTML. Only a public form
 * can be drawn here: a members or personal-link form answers its own page
 * alone. The bot check's work matches src/lib/forms/solve.ts (it can't import
 * it; src/app/f/__tests__/embed.test.ts solves a challenge the server issues
 * with this copy). Whether a text field is a few lines is the shape's own
 * `long`, never a rule of this file's.
 */
(function () {
  'use strict'

  var script = document.currentScript || document.querySelector('script[src*="/f/embed.js"]')
  if (!script || !script.src) return
  var origin = new URL(script.src, window.location.href).origin
  var THANKS = 'Thanks. We got it.'
  var FAILED = 'Something went wrong. Try again.'

  function el(tag, attrs, text) {
    var node = document.createElement(tag)
    if (attrs) {
      Object.keys(attrs).forEach(function (name) {
        var value = attrs[name]
        if (value === false || value === null || value === undefined) return
        if (name === 'style') node.style.cssText = value
        else if (value === true) node.setAttribute(name, '')
        else node.setAttribute(name, String(value))
      })
    }
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  var BOX = 'display:block;width:100%;box-sizing:border-box;margin:4px 0 0;padding:8px 10px;font:inherit;color:inherit;background:transparent;border:1px solid rgba(127,127,127,.45);border-radius:6px;'
  var ROW = 'display:block;margin:0 0 14px;'
  var LABEL = 'display:block;font-weight:600;'

  function zeroBits(bytes) {
    var bits = 0
    for (var i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) {
        bits += 8
        continue
      }
      return bits + Math.clz32(bytes[i]) - 24
    }
    return bits
  }

  async function solve(token, difficulty) {
    var encoder = new TextEncoder()
    var batch = 256
    for (var start = 0; start < 67108864; start += batch) {
      var work = []
      for (var i = 0; i < batch; i++) work.push(crypto.subtle.digest('SHA-256', encoder.encode(token + ':' + (start + i))))
      var digests = await Promise.all(work)
      for (var j = 0; j < batch; j++) if (zeroBits(new Uint8Array(digests[j])) >= difficulty) return String(start + j)
    }
    throw new Error('no answer found')
  }

  function randomId() {
    var bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2) }).join('')
  }

  /** A text field drawn as a few lines: the server says so (src/lib/forms/public.ts formShape). */
  function isLong(field) {
    return field.type === 'text' && field.long === true
  }

  function labelText(field) {
    return field.label + (field.type === 'currency' && field.currency ? ' (' + field.currency + ')' : '') + (field.required ? ' *' : '')
  }

  var MB = 1024 * 1024

  /** Why these files can't be sent, or null: too many, too large, or not a kind the form takes. Matches src/app/f/[key]/form-view.tsx filesProblem. */
  function filesProblem(field, files) {
    var max = field.max_files || 5
    if (files.length > max) return 'Choose at most ' + max + ' files.'
    var kinds = String(field.accept || '').split(',').map(function (e) { return e.trim().replace(/^\./, '').toLowerCase() }).filter(Boolean)
    for (var i = 0; i < files.length; i++) {
      var name = files[i].name
      var dot = name.lastIndexOf('.')
      var ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
      if (kinds.length && kinds.indexOf(ext) < 0) return '"' + name + '" isn\'t a kind of file this form takes.'
      if (files[i].size === 0) return '"' + name + '" is empty.'
      if (field.max_bytes && files[i].size > field.max_bytes) return '"' + name + '" is larger than ' + Math.round(field.max_bytes / MB) + ' MB.'
    }
    return null
  }

  /** One field's row, and a function reading its value for the post (undefined when empty). */
  function drawField(field, index, prefix) {
    var id = prefix + '-' + index
    var row = el('div', { style: ROW })
    var read
    if (field.type === 'file') {
      var most = field.max_files || 5
      row.appendChild(el('label', { for: id, style: LABEL }, labelText(field)))
      var picker = el('input', { type: 'file', id: id, name: field.name, multiple: most > 1, accept: field.accept || null, style: BOX })
      row.appendChild(picker)
      row.appendChild(el('span', { style: 'display:block;margin:4px 0 0;font-size:.85em;opacity:.75;' }, 'Up to ' + most + (most === 1 ? ' file' : ' files') + (field.max_bytes ? ', ' + Math.round(field.max_bytes / MB) + ' MB each.' : '.')))
      read = function () { return Array.prototype.slice.call(picker.files || []) }
      return { row: row, read: read, files: true }
    }
    if (field.type === 'checkbox') {
      var box = el('input', { type: 'checkbox', id: id, name: field.name, required: !!field.required, style: 'margin:0 8px 0 0;vertical-align:middle;' })
      var boxLabel = el('label', { for: id, style: 'vertical-align:middle;' }, labelText(field))
      row.appendChild(box)
      row.appendChild(boxLabel)
      read = function () { return box.checked ? true : undefined }
      return { row: row, read: read }
    }
    if (field.type === 'multi_select') {
      var set = el('fieldset', { style: 'margin:0;padding:0;border:0;' })
      set.appendChild(el('legend', { style: LABEL + 'padding:0;margin:0 0 4px;' }, labelText(field)))
      var boxes = []
      ;(field.options || []).forEach(function (option, j) {
        var optionId = id + '-' + j
        var line = el('div', { style: 'margin:2px 0;' })
        var input = el('input', { type: 'checkbox', id: optionId, name: field.name, value: option, style: 'margin:0 8px 0 0;vertical-align:middle;' })
        line.appendChild(input)
        line.appendChild(el('label', { for: optionId, style: 'vertical-align:middle;' }, option))
        set.appendChild(line)
        boxes.push(input)
      })
      row.appendChild(set)
      read = function () {
        var chosen = boxes.filter(function (b) { return b.checked }).map(function (b) { return b.value })
        return chosen.length ? chosen : undefined
      }
      return { row: row, read: read }
    }
    row.appendChild(el('label', { for: id, style: LABEL }, labelText(field)))
    var control
    if (field.type === 'select') {
      control = el('select', { id: id, name: field.name, required: !!field.required, style: BOX })
      control.appendChild(el('option', { value: '' }, 'Choose...'))
      ;(field.options || []).forEach(function (option) { control.appendChild(el('option', { value: option }, option)) })
    } else if (isLong(field)) {
      control = el('textarea', { id: id, name: field.name, required: !!field.required, rows: 4, maxlength: 5000, style: BOX })
    } else {
      var types = { number: 'number', currency: 'number', date: 'date', url: 'url', email: 'email', phone: 'tel' }
      control = el('input', {
        id: id,
        name: field.name,
        type: types[field.type] || 'text',
        required: !!field.required,
        step: field.type === 'currency' ? '0.01' : field.type === 'number' ? 'any' : null,
        autocomplete: field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : null,
        maxlength: types[field.type] ? null : 5000,
        style: BOX,
      })
    }
    row.appendChild(control)
    read = function () {
      var text = String(control.value || '').trim()
      if (!text) return undefined
      if (field.type === 'number' || field.type === 'currency') {
        var n = Number(text)
        return isFinite(n) ? n : text
      }
      return text
    }
    return { row: row, read: read }
  }

  function line(container, text) {
    while (container.firstChild) container.removeChild(container.firstChild)
    container.appendChild(el('p', { style: 'margin:0;' }, text))
  }

  async function draw(container, index) {
    var key = container.getAttribute('data-ni-form') || ''
    if (!/^fk_[A-Za-z0-9_-]{43}$/.test(key)) return
    container.setAttribute('data-ni-drawn', '')
    var base = origin + '/api/intake/forms/' + encodeURIComponent(key)
    var shape
    try {
      var res = await fetch(base, { credentials: 'omit', cache: 'no-store' })
      if (res.status === 404) return line(container, 'This form was not found.')
      if (res.status === 410) return line(container, 'This form is closed.')
      if (!res.ok) return line(container, "This form can't be shown here.")
      shape = await res.json()
    } catch (e) {
      return line(container, "This form can't be shown right now.")
    }
    if (!shape || shape.access !== 'public' || !Array.isArray(shape.fields)) return line(container, "This form can't be shown here.")

    var challenge = null
    function startChallenge() {
      challenge = (async function () {
        var r = await fetch(base + '/challenge', { credentials: 'omit', cache: 'no-store' })
        if (!r.ok) throw new Error(String(r.status))
        var c = await r.json()
        return { token: c.token, answer: await solve(c.token, c.difficulty) }
      })()
      challenge.catch(function () {})
    }
    if (shape.bot_check) startChallenge()

    var form = el('form', { style: 'margin:0;' })
    if (shape.name) form.appendChild(el('p', { style: 'margin:0 0 6px;font-weight:600;font-size:1.15em;' }, shape.name))
    if (shape.description) form.appendChild(el('p', { style: 'margin:0 0 14px;white-space:pre-line;opacity:.8;' }, shape.description))
    var prefix = 'ni-form-' + index
    var readers = shape.fields.map(function (field, i) {
      var drawn = drawField(field, i, prefix)
      form.appendChild(drawn.row)
      return { name: field.name, read: drawn.read, files: !!drawn.files, field: field }
    })
    // A field people never see: bots fill it.
    var gotcha = el('input', { type: 'text', name: '_gotcha', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true', style: 'position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden;' })
    form.appendChild(gotcha)
    var error = el('p', { role: 'alert', style: 'margin:0 0 10px;color:#b91c1c;' })
    error.hidden = true
    form.appendChild(error)
    var button = el('button', { type: 'submit', style: 'font:inherit;padding:8px 16px;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;' }, shape.submit_label || 'Send')
    form.appendChild(button)
    var submissionId = randomId()

    form.addEventListener('submit', async function (event) {
      event.preventDefault()
      button.disabled = true
      error.hidden = true
      var body = { submission_id: submissionId, _gotcha: gotcha.value }
      var fileReader = null
      var chosen = []
      readers.forEach(function (r) {
        if (r.files) {
          fileReader = r
          chosen = r.read()
          return
        }
        var v = r.read()
        if (v !== undefined) body[r.name] = v
      })
      var problem = fileReader ? filesProblem(fileReader.field, chosen) : null
      if (!problem && fileReader && fileReader.field.required && !chosen.length) problem = fileReader.field.label + ' is required.'
      if (problem) {
        error.textContent = problem
        error.hidden = false
        button.disabled = false
        return
      }
      try {
        if (shape.bot_check) {
          var solved
          try {
            solved = await challenge
          } catch (e) {
            startChallenge()
            solved = await challenge
          }
          body._challenge = solved.token
          body._answer = solved.answer
        }
        var res
        if (fileReader) {
          // Its fields and its files in one multipart body (the browser sets its boundary).
          var multipart = new FormData()
          Object.keys(body).forEach(function (name) {
            var value = body[name]
            if (Array.isArray(value)) value.forEach(function (item) { multipart.append(name, String(item)) })
            else multipart.append(name, String(value))
          })
          chosen.forEach(function (file) { multipart.append(fileReader.name, file, file.name) })
          res = await fetch(base, { method: 'POST', credentials: 'omit', body: multipart })
        } else {
          res = await fetch(base, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        }
        var data = {}
        try {
          data = await res.json()
        } catch (e) {
          data = {}
        }
        if (!res.ok || !data.ok) {
          error.textContent = typeof data.error === 'string' ? data.error : FAILED
          error.hidden = false
          if (data.code === 'CHALLENGE_FAILED' && shape.bot_check) startChallenge()
          button.disabled = false
          return
        }
        line(container, shape.thanks || data.thanks || THANKS)
      } catch (e) {
        error.textContent = FAILED
        error.hidden = false
        button.disabled = false
      }
    })

    while (container.firstChild) container.removeChild(container.firstChild)
    container.appendChild(form)
  }

  var count = 0
  function start() {
    var found = document.querySelectorAll('[data-ni-form]:not([data-ni-drawn])')
    Array.prototype.forEach.call(found, function (container) { draw(container, count++) })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
