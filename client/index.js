// client/index.js — resident edit-checkpoint dock above the composer.
//
// Hand-written browser module, same shape as the other DSH client plugins:
// React comes from the shell through require('react'), the Remote descriptors
// mirror lib/wire.mjs, and the dock registers into conversation.input.dock.
// The conversation itself keeps the built-in "已编辑" turn card.

window.__ModuleLoader__.load({
  id: 'dsh-checkpoint-dock',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var react = require('react')
    var primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var createElement = react.createElement
    var Fragment = react.Fragment
    var useState = react.useState
    var useEffect = react.useEffect
    var useCallback = react.useCallback
    var useRef = react.useRef

    var NS = 'dsh-checkpoint-dock'
    var PACKAGE = 'dsh-checkpoint-dock'
    var SERVICE = 'editCheckpoints'
    var SOURCE_LOCATION = Object.freeze({ file: 'lib/wire.mjs', line: 1, column: 1 })

    // --- User settings (client-only, persisted in this browser). ---
    var SETTINGS_KEY = 'dsh-checkpoint-dock:settings'
    var SETTINGS_COOKIE = 'dsh-checkpoint-dock-settings'
    var DEFAULT_SETTINGS = Object.freeze({ resident: true, jumpToTurn: true })
    var settingsListeners = new Set()

    function readSettingsCookie() {
      try {
        var pairs = String(document.cookie || '').split('; ')
        for (var index = 0; index < pairs.length; index += 1) {
          var at = pairs[index].indexOf('=')
          if (at < 0 || pairs[index].slice(0, at) !== SETTINGS_COOKIE) continue
          return JSON.parse(decodeURIComponent(pairs[index].slice(at + 1)))
        }
      } catch (failure) {}
      return null
    }

    function writeSettingsCookie(value) {
      try {
        // Cookies are not port-scoped, unlike localStorage, so these settings
        // survive a DSH restart on a different localhost port.
        document.cookie = SETTINGS_COOKIE + '=' + encodeURIComponent(JSON.stringify(value))
          + '; path=/; max-age=31536000; SameSite=Lax'
      } catch (failure) {}
    }

    function readSettings() {
      var stored = readSettingsCookie()
      if (!stored) {
        try { stored = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || 'null') } catch (failure) { stored = null }
      }
      var source = stored && typeof stored === 'object' ? stored : {}
      return {
        resident: source.resident !== false,
        jumpToTurn: source.jumpToTurn !== false,
      }
    }

    var currentSettings = readSettings()

    function getSettings() {
      return currentSettings
    }

    function updateSettings(patch) {
      currentSettings = {
        resident: patch.resident !== undefined ? patch.resident !== false : currentSettings.resident,
        jumpToTurn: patch.jumpToTurn !== undefined ? patch.jumpToTurn !== false : currentSettings.jumpToTurn,
      }
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings)) } catch (failure) {}
      writeSettingsCookie(currentSettings)
      settingsListeners.forEach(function (listener) {
        try { listener(currentSettings) } catch (failure) {}
      })
    }

    function subscribeSettings(listener) {
      settingsListeners.add(listener)
      return function () { settingsListeners.delete(listener) }
    }

    // --- Wire descriptors (must match lib/wire.mjs exactly). ---
    function passthrough(typeSymbol) {
      return Object.freeze({
        mode: 'strict',
        typeSymbol: typeSymbol,
        create: function () {
          return { parse: function (value) { return value } }
        },
      })
    }

    var sessionIdCodec = passthrough(PACKAGE + '/types#SessionId')
    var turnCodec = passthrough(PACKAGE + '/types#Turn')
    var recordCodec = passthrough(PACKAGE + '/types#EditCheckpoint')
    var actionCodec = passthrough(PACKAGE + '/types#EditCheckpointAction')

    function parameter(name, codec) {
      return Object.freeze({ name: name, wire: name, source: 'json', codec: codec })
    }

    function descriptor(method, result, names) {
      return Object.freeze({
        id: PACKAGE + '#' + SERVICE + '/' + method,
        service: SERVICE,
        namespace: SERVICE,
        method: method,
        invocation: Object.freeze({ kind: 'direct' }),
        parameters: Object.freeze(names.map(function (name) {
          return parameter(name, name === 'sessionId' ? sessionIdCodec : turnCodec)
        })),
        result: result,
        sourceLocation: SOURCE_LOCATION,
      })
    }

    var INVOCATIONS = Object.freeze([
      descriptor('get', recordCodec, ['sessionId', 'turn']),
      descriptor('keep', actionCodec, ['sessionId', 'turn']),
      descriptor('undo', actionCodec, ['sessionId', 'turn']),
    ])

    function unwrap(result) {
      if (result !== null && typeof result === 'object' && result.ok === true && 'value' in result) return result.value
      if (result !== null && typeof result === 'object' && result.ok === false && result.error) {
        var code = result.error.code ? result.error.code : 'remote'
        var message = result.error.message ? result.error.message : 'Remote call failed'
        var error = new Error(code + ': ' + message)
        error.code = code
        throw error
      }
      // A direct service return can itself be `{ ok, record }`; the Host
      // service is the authority for shape either way.
      return result
    }

    // --- Copy. ---
    var locales = {
      zh: {
        checkpoints: '检查点',
        dockTitle: '检查点',
        noRecords: '还没有检查点。文件被修改后会自动出现在这里。',
        settingsTab: '检查点',
        settingsTitle: '检查点',
        settingsHint: '控制检查点 Dock 的显示和跳转行为；这些设置只影响当前浏览器。',
        resident: '常驻显示',
        residentHint: '有检查点时保持显示；关闭后只在本轮有未处理检查点时出现。',
        jumpToTurn: '点击跳转对话',
        jumpHint: '点击检查点时滚动到对应的对话轮次。',
        settingsReset: '恢复默认',
        tabsOverview: '总览',
        tabsConfig: '配置',
        historyTitle: '检查点历史',
        historyHint: '所有会话的检查点都在这里；输入框上方的 Dock 隐藏时，也能从这里回看。',
        historyEmpty: '还没有检查点。',
        historyRefresh: '刷新',
        historyLoadFailed: '读取检查点失败',
        historySession: '会话',
        historyFiles: '{n} 个文件',
        historyNoIndex: '没有可跳转的对话位置',
        title: '检查点 {n}',
        rawTurn: '第 {n} 轮',
        count: '{n} 条',
        filter: '筛选',
        filterAll: '全部',
        summaryPending: '待处理',
        sessionFilter: '会话',
        allSessions: '全部会话',
        filterOpen: '记录中',
        filterSealed: '未处理',
        filterKept: '已保留',
        filterUndone: '已撤销',
        filterEmpty: '没有匹配的检查点',
        loadMore: '加载更早的 {n} 条',
        files: '{n} 个文件',
        defaultPrompt: '修改了文件',
        recording: '记录中',
        kept: '已保留',
        undone: '已撤销',
        keep: '保留',
        undo: '撤销',
        confirmUndo: '确认撤销',
        revert: '回退到此',
        confirmRevert: '确认回退',
        revertTarget: '恢复到检查点 {n} 结束时的文件状态',
        revertLatest: '已经是最新检查点',
        revertRecording: '检查点还在记录中，不能回退',
        revertDone: '已撤销的检查点不能作为回退目标',
        revertKeptLater: '检查点 {n} 已保留，无法越过它回退',
        revertKeptWarning: '回退会一并撤销 {n} 条已保留检查点',
        revertOpenLater: '检查点 {n} 还在记录中，请稍后再回退',
        revertFailed: '回退失败',
        undoKept: '已保留，不能再撤销',
        undoAccepted: '检查点 {n} 已保留，之前的修改已一并接受',
        undoNewer: '请先撤销检查点 {n}',
        redoEarlier: '请先重做检查点 {n}',
        undoKeptLater: '检查点 {n} 已保留，无法撤销更早的检查点',
        undoOpenLater: '检查点 {n} 还在记录中，请稍后再撤销',
        keepNewer: '请先处理检查点 {n}',
        keepKeptLater: '检查点 {n} 已保留，只能从最新开始保留',
        keepOpenLater: '检查点 {n} 还在记录中，请稍后再保留',
        undoRecording: '检查点还在记录中',
        undoDone: '这条检查点已经撤销',
        review: '查看变更',
        binary: '二进制',
        more: '展开其余 {n} 个文件',
        less: '收起',
        noFiles: '没有文件变更',
        loadFailed: '读取检查点失败',
        actionFailed: '操作失败',
        select: '选择检查点',
        redo: '重做',
        pin: '钉住',
        pinned: '已钉住',
        unpin: '取消钉住',
        pinHint: '钉住后清理旧内容时不会删除它',
        pinRecording: '检查点还在记录中',
        pinRemoved: '内容已清理，无法钉住',
        storage: '存储',
        storageTitle: '检查点存储',
        storageSummary: '{n} 条记录 · {size} · 可清理 {cleanable}',
        storagePinned: '{n} 条已钉住，不参与清理',
        storagePolicy: '只清理最早的记录内容，保留最近 {n} 条和所有钉住项；清理后记录仍在，但不能再查看/撤销/重做。',
        clean: '清理旧内容',
        confirmClean: '确认清理',
        cleanDone: '已清理 {n} 条记录',
        cleanNothing: '没有可清理的旧内容',
        storageOrphans: '已删除的会话：{sessions} 个会话 · {records} 条检查点 · {size}',
        storageOrphanHint: '会话在 DSH 里被删除后，检查点会一直留在磁盘上，直到你手动清理。',
        purgeOrphans: '清理已删除会话的检查点',
        confirmPurge: '确认删除这些检查点',
        purgeDone: '已清理 {records} 条检查点，释放 {size}',
        purgeNothing: '没有可清理的已删除会话',
        storageFailure: '最近一次写入失败：{message}',
        storageAutoClean: '自动清理检查点',
        storageKeep: '保留最近',
        storageKeepOption: '{n} 条',
        contentRemoved: '内容已清理',
        recovered: '已恢复',
        diff: '查看变更',
        hideDiff: '收起变更',
        diffLoading: '正在读取变更…',
        diffUnavailable: '这条记录没有可用的内容（旧记录或已清理）',
        diffBinary: '二进制文件不显示文本差异',
        diffTruncated: '差异过大，只显示文件统计',
        diffEmpty: '没有文本差异',
      },
      en: {
        checkpoints: 'Checkpoints',
        dockTitle: 'Checkpoints',
        noRecords: 'No checkpoints yet. They appear here after files change.',
        settingsTab: 'Checkpoints',
        settingsTitle: 'Checkpoints',
        settingsHint: 'Control the checkpoint dock visibility and turn jumping. These settings apply to this browser.',
        resident: 'Always visible',
        residentHint: 'Keep the dock visible when checkpoints exist; when off, it appears only for unhandled checkpoints in this turn.',
        jumpToTurn: 'Jump to turn',
        jumpHint: 'Scroll to the matching conversation turn when a checkpoint is clicked.',
        settingsReset: 'Reset defaults',
        tabsOverview: 'Overview',
        tabsConfig: 'Settings',
        historyTitle: 'Checkpoint history',
        historyHint: 'Every checkpoint from every session; use this when the composer dock is hidden.',
        historyEmpty: 'No checkpoints yet.',
        historyRefresh: 'Refresh',
        historyLoadFailed: 'Failed to load checkpoints',
        historySession: 'Session',
        historyFiles: '{n} files',
        historyNoIndex: 'No conversation position to jump to',
        title: 'Checkpoint {n}',
        rawTurn: 'turn {n}',
        count: '{n}',
        filter: 'Filter',
        filterAll: 'All',
        summaryPending: 'Pending',
        sessionFilter: 'Session',
        allSessions: 'All sessions',
        filterOpen: 'Recording',
        filterSealed: 'Unhandled',
        filterKept: 'Kept',
        filterUndone: 'Undone',
        filterEmpty: 'No matching checkpoints',
        loadMore: 'Load {n} older',
        files: '{n} files',
        defaultPrompt: 'Files changed',
        recording: 'Recording',
        kept: 'Kept',
        undone: 'Undone',
        keep: 'Keep',
        undo: 'Undo',
        confirmUndo: 'Confirm undo',
        revert: 'Revert to here',
        confirmRevert: 'Confirm revert',
        revertTarget: 'Restore files to the end of checkpoint {n}',
        revertLatest: 'This is already the latest checkpoint',
        revertRecording: 'This checkpoint is still recording',
        revertDone: 'An undone checkpoint cannot be a revert target',
        revertKeptLater: 'Checkpoint {n} was kept; cannot revert past it',
        revertKeptWarning: 'Reverting also undoes {n} kept checkpoint(s)',
        revertOpenLater: 'Checkpoint {n} is still recording',
        revertFailed: 'Revert failed',
        undoKept: 'Kept checkpoints cannot be undone',
        undoAccepted: 'Checkpoint {n} is kept; earlier changes are accepted',
        undoNewer: 'Undo checkpoint {n} first',
        redoEarlier: 'Redo checkpoint {n} first',
        undoKeptLater: 'Checkpoint {n} was kept, so earlier checkpoints cannot be undone',
        undoOpenLater: 'Checkpoint {n} is still recording',
        keepNewer: 'Handle checkpoint {n} first',
        keepKeptLater: 'Checkpoint {n} was kept; keep from the newest checkpoint',
        keepOpenLater: 'Checkpoint {n} is still recording',
        undoRecording: 'This checkpoint is still recording',
        undoDone: 'This checkpoint was already undone',
        review: 'View changes',
        binary: 'binary',
        more: 'Show {n} more files',
        less: 'Show less',
        noFiles: 'No file changes',
        loadFailed: 'Could not read checkpoints',
        actionFailed: 'Action failed',
        select: 'Select a checkpoint',
        redo: 'Redo',
        pin: 'Pin',
        pinned: 'Pinned',
        unpin: 'Unpin',
        pinHint: 'Pinned content is excluded from cleanup',
        pinRecording: 'This checkpoint is still recording',
        pinRemoved: 'Content was cleaned; cannot pin',
        storage: 'Storage',
        storageTitle: 'Checkpoint storage',
        storageSummary: '{n} records · {size} · {cleanable} cleanable',
        storagePinned: '{n} pinned records are never cleaned',
        storagePolicy: 'Only the oldest content is cleaned; the latest {n} and all pinned content stay. Records remain, but their diff/undo/redo stop working.',
        clean: 'Clean old content',
        confirmClean: 'Confirm clean',
        cleanDone: 'Cleaned {n} records',
        cleanNothing: 'Nothing to clean',
        storageOrphans: 'Deleted sessions: {sessions} sessions · {records} checkpoints · {size}',
        storageOrphanHint: 'Deleting a session in DSH leaves its checkpoints on disk until you clean them up here.',
        purgeOrphans: 'Clean up deleted sessions',
        confirmPurge: 'Confirm deleting these checkpoints',
        purgeDone: 'Removed {records} checkpoints and freed {size}',
        purgeNothing: 'No checkpoints from deleted sessions',
        storageFailure: 'Last write failed: {message}',
        storageAutoClean: 'Clean up automatically',
        storageKeep: 'Keep the latest',
        storageKeepOption: '{n} records',
        contentRemoved: 'Content cleaned',
        recovered: 'Recovered',
        diff: 'View changes',
        hideDiff: 'Hide changes',
        diffLoading: 'Loading changes…',
        diffUnavailable: 'No content is available for this record (old or cleaned)',
        diffBinary: 'Binary files have no text diff',
        diffTruncated: 'Diff is too large; only file stats are shown',
        diffEmpty: 'No text diff',
      },
    }

    // --- Styles. ---
    var STYLES = [
      '.ecp_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));max-width:calc(var(--dsh-composer-card-max-width,920px) - var(--dsh-composer-dock-inset,8px) - var(--dsh-composer-dock-inset,8px));margin:0 auto 2px;padding:0 var(--dsh-composer-dock-inset,8px);flex:none;display:flex;min-width:0}',
      '.ecp_panel{box-sizing:border-box;width:100%;min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-panel);backdrop-filter:var(--dsw-menu-backdrop-filter);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;overflow:hidden}',
      '.ecp_panel[data-menu-open=true]{overflow:visible}',
      '.ecp_head{box-sizing:border-box;width:100%;height:32px;color:inherit;background:0 0;border:0;font:inherit;text-align:left;cursor:pointer;align-items:center;gap:8px;padding:0 12px;display:flex}',
      '.ecp_filterRow{display:flex;align-items:center;gap:6px;padding:2px 12px 5px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ecp_filterLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.ecp_sessionPicker.ecp_filterPicker{flex:0 0 auto;width:auto;min-width:105px;max-width:150px}',
      '.ecp_empty{padding:10px 12px;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.ecp_head:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ecp_head:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.ecp_headIcon{color:var(--dsw-alias-label-tertiary);display:inline-flex;flex:none}',
      '.ecp_headTitle{font-size:12px;font-weight:500;line-height:20px;flex:none}',
      '.ecp_headCount{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;flex:1}',
      '.ecp_chev{color:var(--dsw-alias-label-tertiary);display:inline-flex;flex:none;transition:transform .12s}',
      '.ecp_panel[data-collapsed=true] .ecp_chev{transform:rotate(-90deg)}',
      '.ecp_cps{border-top:.5px solid var(--dsw-alias-border-l1);max-height:156px;overflow-y:auto;overscroll-behavior:contain}',
      '.ecp_cp{box-sizing:border-box;width:100%;min-width:0;border:0;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer;align-items:center;gap:10px;padding:6px 12px;display:flex}',
      '.ecp_cp:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ecp_cp:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.ecp_cp[data-selected=true]{background:var(--dsw-alias-interactive-bg-hover);box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}',
      '.ecp_cpMain{min-width:0;flex-direction:column;flex:1;display:flex}',
      '.ecp_cpTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;line-height:18px}',
      '.ecp_cpPrompt{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}',
      '.ecp_cpRight{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);flex:none;align-items:center;gap:6px;font-size:11px;display:inline-flex}',
      '.ecp_cpCheck{color:var(--dsw-alias-state-success-primary);display:inline-flex}',
      '.ecp_cpState{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family);font-size:10px}',
      '.ecp_add{color:var(--dsw-alias-state-success-primary)}',
      '.ecp_del{color:var(--dsw-alias-state-error-primary)}',
      '.ecp_files{border-top:.5px solid var(--dsw-alias-border-l1);margin:0;padding:0;list-style:none;max-height:150px;overflow-y:auto;overscroll-behavior:contain}',
      '.ecp_file{box-sizing:border-box;width:100%;min-width:0;min-height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:var(--ds-font-family-code);text-align:left;background:0 0;border:0;justify-content:space-between;align-items:center;gap:8px;margin:0;padding:5px 12px;font-size:11px;line-height:18px;display:flex}',
      '.ecp_file:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ecp_file:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.ecp_ext{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l1);border-radius:4px;background:var(--dsw-alias-bg-layer-2);flex:none;place-items:center;width:18px;height:18px;color:var(--dsw-alias-label-tertiary);font-size:9px;font-weight:600;line-height:1;display:grid;letter-spacing:-.02em}',
      '.ecp_filePath{min-width:0;font-family:var(--ds-font-family-code);text-overflow:ellipsis;white-space:nowrap;font-size:11px;overflow:hidden;flex:1}',
      '.ecp_fileCounts{white-space:nowrap;color:var(--dsw-alias-label-tertiary);flex:none;gap:6px;display:inline-flex}',
      '.ecp_more{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;text-align:left;background:0 0;border:0;justify-content:flex-start;align-items:center;gap:4px;margin:0;padding:5px 12px;font-size:11px;line-height:18px;display:inline-flex}',
      '.ecp_more:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ecp_foot{box-sizing:border-box;border-top:.5px solid var(--dsw-alias-border-l1);align-items:center;gap:8px;width:100%;padding:6px 10px 6px 12px;display:flex;flex-wrap:wrap}',
      '.ecp_meta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;min-width:0;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.ecp_actions{align-items:center;gap:6px;display:flex;flex:none}',
      '.ecp_btn{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;line-height:1;align-items:center;justify-content:center;height:26px;padding:0 10px;display:inline-flex;white-space:nowrap}',
      '.ecp_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ecp_btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.ecp_btn:disabled{opacity:.5;cursor:default}',
      '.ecp_keep{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.ecp_undo.is-confirm{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.ecp_revert.is-confirm{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.ecp_error{color:var(--dsw-alias-state-error-primary);border-top:.5px solid var(--dsw-alias-border-l1);padding:5px 12px;font-size:11px;line-height:16px}',
      '.ecp_pinPill{color:var(--dsw-alias-state-business-primary);font-size:10px;font-family:var(--ds-font-family);margin-left:6px}',
      '.ecp_diff{border-top:.5px solid var(--dsw-alias-border-l1);max-height:260px;overflow:auto;overscroll-behavior:contain;background:var(--dsw-alias-bg-layer-2)}',
      '.ecp_diffFile{padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ecp_diffHead{display:flex;align-items:center;gap:6px;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.ecp_patch{margin:4px 0 0;padding:0;list-style:none;font-family:var(--ds-font-family-code);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}',
      '.ecp_patchLine{padding:0 2px}',
      '.ecp_patchAdd{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.ecp_patchDel{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.ecp_patchMeta{color:var(--dsw-alias-label-tertiary);font-size:10px;padding:2px 12px 4px}',
      '.ecp_storage{border-top:.5px solid var(--dsw-alias-border-l1);padding:6px 12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary)}',
      '.ecp_storageRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ecp_storageRow .ecp_btn{margin-left:auto}',
      '.ecp_storageTitle{color:var(--dsw-alias-label-primary);font-weight:500;margin-bottom:2px}',
      '.ecp_storageWarn{color:var(--dsw-alias-state-error-primary,#d33);margin-top:4px}',
      '.ecp_storageOrphans{margin-top:6px;border-top:.5px dashed var(--dsw-alias-border-l2);padding-top:6px}',
      '.ecp_storageOrphanText{color:var(--dsw-alias-label-secondary)}',
      '.ecp_storageHint{color:var(--dsw-alias-label-tertiary);margin:2px 0 4px}',
      '.ecp_storageSetting{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:4px 0 2px}',
      '.ecp_storageToggle{display:inline-flex;align-items:center;gap:6px;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.ecp_storageCheck{margin:0;accent-color:var(--dsw-alias-state-accent-primary,#5b8def);cursor:pointer}',
      '.ecp_storageSelect{font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:1px 4px;cursor:pointer}',
      '.ecp_status{font-family:var(--ds-font-family);font-size:10px;color:var(--dsw-alias-label-tertiary);margin-left:6px}',
      '.ecp_emptyHead{display:flex;align-items:center;gap:8px;padding:10px 12px;color:var(--dsw-alias-label-secondary)}',
      '.ecp_emptyTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.ecp_emptyCount{margin-left:auto;font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.ecp_empty{padding:2px 12px 10px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}',
      '.ecp_settings{max-width:640px;padding:20px 0 16px}',
      '.ecp_settingsTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}',
      '.ecp_settingsHint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px;margin-bottom:14px}',
      '.ecp_settingRow{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-top:.5px solid var(--dsw-alias-border-l1);cursor:pointer}',
      '.ecp_settingText{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.ecp_settingLabel{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.ecp_settingHint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px}',
      '.ecp_toggle{accent-color:var(--dsw-alias-state-business-primary);width:16px;height:16px;flex:none;cursor:pointer;margin-top:2px}',
      '.ecp_settingsFooter{margin-top:14px}',
      '.ecp_tabs{display:flex;gap:4px;margin:14px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ecp_tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;padding:7px 10px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-.5px}',
      '.ecp_tab:hover{color:var(--dsw-alias-label-primary)}',
      '.ecp_tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary)}',
      '.ecp_settingsPane{padding-top:2px}',
      '.ecp_history{display:flex;flex-direction:column;gap:10px}',
      '.ecp_summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}',
      '.ecp_summaryChip{box-sizing:border-box;min-width:0;border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border-radius:8px;padding:7px 9px;text-align:left;font:inherit;cursor:pointer;display:flex;align-items:baseline;gap:6px}',
      '.ecp_summaryChip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.ecp_summaryChip.is-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}',
      '.ecp_summaryLabel{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ecp_summaryCount{margin-left:auto;font-family:var(--ds-font-family-code);font-size:12px;color:var(--dsw-alias-label-primary)}',
      '.ecp_sessionRow{display:flex;align-items:center;gap:8px}',
      '.ecp_sessionRowLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;flex:none}',
      '.ecp_sessionPicker{position:relative;min-width:0;max-width:320px;flex:1}',
      '.ecp_sessionButton{box-sizing:border-box;width:100%;height:28px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 8px 0 10px;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:7px;cursor:pointer}',
      '.ecp_sessionButton:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ecp_sessionButton:focus,.ecp_sessionButton:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.ecp_sessionButton.is-open{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}',
      '.ecp_sessionButtonText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ecp_sessionChevron{flex:none;font-size:9px;color:var(--dsw-alias-label-tertiary)}',
      '.ecp_sessionMenu{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;box-sizing:border-box;max-height:260px;overflow:auto;padding:4px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.3)}',
      '.ecp_sessionMenu.ecp_filterMenu{right:auto;min-width:100%;max-width:240px}',
      '.ecp_sessionOption{box-sizing:border-box;width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 8px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;text-align:left;cursor:pointer}',
      '.ecp_sessionOption:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ecp_sessionOption.is-active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ecp_sessionOptionText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ecp_sessionCheck{flex:none;color:var(--dsw-alias-state-business-primary);font-size:11px}',
      '.ecp_sessionTag{display:inline-block;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);font-size:10px;font-weight:400;vertical-align:middle}',
      '.ecp_historyHead{display:flex;align-items:flex-start;gap:12px}',
      '.ecp_historyText{flex:1;min-width:0}',
      '.ecp_historyTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:2px}',
      '.ecp_historyHead .ecp_settingsHint{margin-bottom:0}',
      '.ecp_histRows{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l1)}',
      '.ecp_histRow{display:flex;align-items:flex-start;gap:12px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.ecp_histMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}',
      '.ecp_histTitleLine{display:flex;align-items:center;gap:6px;min-width:0}',
      '.ecp_histTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.ecp_histStatus{font-size:10px;color:var(--dsw-alias-label-tertiary);border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}',
      '.ecp_histPrompt{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ecp_histMeta{font-size:10px;color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;gap:4px;flex-wrap:wrap}',
      '.ecp_histSession{font-family:var(--ds-font-family-code)}',
      '.ecp_histReason{font-size:10px;color:var(--dsw-alias-label-tertiary)}',
      '.ecp_histRow>.ecp_btn{flex:none;margin-top:2px}',
      '.ecp_file.is-disabled{opacity:.55;cursor:default}',
      '@media (pointer:coarse){.ecp_file,.ecp_more,.ecp_cp{min-height:40px}}',
    ].join('\n')

    function installStyles() {
      if (document.querySelector('style[data-dsh-checkpoint-dock]')) return
      var style = document.createElement('style')
      style.setAttribute('data-dsh-checkpoint-dock', '')
      style.textContent = STYLES
      document.head.appendChild(style)
    }

    // --- Small presentational helpers. ---
    function extensionOf(file) {
      var name = String(file || '').split('/').pop().split('\\').pop()
      var dot = name.lastIndexOf('.')
      if (dot <= 0 || dot === name.length - 1) return '•'
      return name.slice(dot + 1).toUpperCase().slice(0, 3)
    }

    function format(t, key, value) {
      return String(t(key)).replace('{n}', String(value))
    }

    /**
     * Fill several named placeholders in one string. `format` only handles a
     * single `{n}`; the storage lines need numbers and a size at once.
     * @param {(key: string) => string} t
     * @param {string} key
     * @param {Record<string, string|number>} values
     */
    function fill(t, key, values) {
      var text = String(t(key))
      var names = Object.keys(values)
      for (var index = 0; index < names.length; index += 1) {
        text = text.split('{' + names[index] + '}').join(String(values[names[index]]))
      }
      return text
    }

    function formatSize(bytes) {
      var value = Number(bytes) || 0
      if (value < 1024) return String(value) + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB'
      return (value / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function checkpointIcon(size) {
      return createElement('svg', {
        viewBox: '0 0 24 24', width: size || 20, height: size || 20, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, [
        createElement('circle', { key: 'c', cx: 12, cy: 12, r: 8.25 }),
        createElement('path', { key: 'p', d: 'M8.25 12.25l2.35 2.35 5.15-5.4' }),
      ])
    }

    function checkIcon() {
      return createElement('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, createElement('path', { d: 'M5 12.5l4.5 4.5L19 7' }))
    }

    function chevron() {
      return createElement('svg', {
        viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, createElement('path', { d: 'M6 9l6 6 6-6' }))
    }

    // --- Resident dock. ---
    function EditCheckpointsDock(props) {
      var sessionId = props.sessionId
      var api = props.api
      var t = props.t || function (key) { return key }
      var openReview = props.openReview
      var openFile = props.openFile
      var settingsState = useState(getSettings())
      var settings = settingsState[0]
      var setSettings = settingsState[1]

      useEffect(function () {
        return subscribeSettings(function (next) { setSettings(next) })
      }, [])

      var recordsState = useState([])
      var records = recordsState[0]
      var setRecords = recordsState[1]
      var selectedState = useState(null)
      var selectedTurn = selectedState[0]
      var setSelectedTurn = selectedState[1]
      var loadedState = useState(false)
      var loaded = loadedState[0]
      var setLoaded = loadedState[1]
      var busyState = useState('')
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var confirmTurnState = useState(null)
      var confirmTurn = confirmTurnState[0]
      var setConfirmTurn = confirmTurnState[1]
      var confirmRevertState = useState(false)
      var confirmRevert = confirmRevertState[0]
      var setConfirmRevert = confirmRevertState[1]
      var collapsedState = useState(true)
      var collapsed = collapsedState[0]
      var setCollapsed = collapsedState[1]
      var filterState = useState('all')
      var filter = filterState[0]
      var setFilter = filterState[1]
      var filterMenuState = useState(false)
      var filterMenuOpen = filterMenuState[0]
      var setFilterMenuOpen = filterMenuState[1]
      var filterPickerRef = useRef(null)
      var lastSignatureRef = useRef('')
      var pageState = useState(30)
      var visibleLimit = pageState[0]
      var setVisibleLimit = pageState[1]
      var showAllFilesState = useState(false)
      var showAllFiles = showAllFilesState[0]
      var setShowAllFiles = showAllFilesState[1]
      var showDiffState = useState(false)
      var showDiff = showDiffState[0]
      var setShowDiff = showDiffState[1]
      var diffState = useState(null)
      var diff = diffState[0]
      var setDiff = diffState[1]
      var diffLoadingState = useState(false)
      var diffLoading = diffLoadingState[0]
      var setDiffLoading = diffLoadingState[1]
      var showStorageState = useState(false)
      var showStorage = showStorageState[0]
      var setShowStorage = showStorageState[1]
      var statsState = useState(null)
      var stats = statsState[0]
      var setStats = statsState[1]
      var confirmCleanState = useState(false)
      var confirmClean = confirmCleanState[0]
      var setConfirmClean = confirmCleanState[1]
      var confirmPurgeState = useState(false)
      var confirmPurge = confirmPurgeState[0]
      var setConfirmPurge = confirmPurgeState[1]
      var pinBusyState = useState(false)
      var pinBusy = pinBusyState[0]
      var setPinBusy = pinBusyState[1]

      var refresh = useCallback(function () {
        if (!sessionId || !api) return
        api.list(sessionId).then(function (list) {
          // A malformed or empty answer is not "this session has no
          // checkpoints": keeping the last good list beats hiding the dock
          // while the host half is still coming up.
          if (!Array.isArray(list)) {
            setLoaded(true)
            return
          }
          var next = list
          var signature = next.map(function (record) {
            return [record.sessionId, record.turn, record.status, record.pinned ? 1 : 0,
              record.contentRemoved ? 1 : 0, record.added || 0, record.deleted || 0,
              (record.files || []).map(function (file) { return file.path }).join(','),
              record.sessionTitle || ''].join(':')
          }).join('|')
          if (signature === lastSignatureRef.current) {
            setLoaded(true)
            setError('')
            return
          }
          lastSignatureRef.current = signature
          setRecords(next)
          setLoaded(true)
          setError('')
          setSelectedTurn(function (current) {
            if (current !== null && next.some(function (record) { return record.turn === current })) return current
            return next.length > 0 ? next[next.length - 1].turn : null
          })
        }).catch(function (failure) {
          setLoaded(true)
          setError(failure && failure.message ? failure.message : t('loadFailed'))
        })
      }, [sessionId, api])

      var loadStats = useCallback(function () {
        if (!sessionId || !api) return
        api.stats(sessionId).then(function (result) {
          setStats(result)
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        })
      }, [sessionId, api])

      useEffect(function () {
        refresh()
      }, [refresh])

      useEffect(function () {
        // Keep polling even while collapsed: a dock that missed its first load
        // (host half still starting, service not injected yet) would otherwise
        // stay empty — and therefore invisible — until the page was reloaded.
        var delay = collapsed ? 15000 : 5000
        var timer = setInterval(function () {
          if (!document.hidden) refresh()
        }, delay)
        var onVisible = function () {
          if (!document.hidden) refresh()
        }
        document.addEventListener('visibilitychange', onVisible)
        return function () {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [collapsed, refresh])

      useEffect(function () {
        setShowDiff(false)
        setDiff(null)
      }, [selectedTurn])

      useEffect(function () {
        if (showStorage) loadStats()
      }, [showStorage, loadStats])

      useEffect(function () {
        if (confirmTurn === null) return undefined
        var timer = setTimeout(function () { setConfirmTurn(null) }, 4000)
        return function () { clearTimeout(timer) }
      }, [confirmTurn])

      useEffect(function () {
        if (!confirmRevert) return undefined
        var timer = setTimeout(function () { setConfirmRevert(false) }, 4000)
        return function () { clearTimeout(timer) }
      }, [confirmRevert])

      useEffect(function () {
        if (!confirmClean) return undefined
        var timer = setTimeout(function () { setConfirmClean(false) }, 4000)
        return function () { clearTimeout(timer) }
      }, [confirmClean])

      useEffect(function () {
        if (!confirmPurge) return undefined
        var timer = setTimeout(function () { setConfirmPurge(false) }, 4000)
        return function () { clearTimeout(timer) }
      }, [confirmPurge])

      useEffect(function () {
        if (!filterMenuOpen) return undefined
        var closeOnOutside = function (event) {
          if (filterPickerRef.current && !filterPickerRef.current.contains(event.target)) setFilterMenuOpen(false)
        }
        var closeOnEscape = function (event) {
          if (event.key === 'Escape') setFilterMenuOpen(false)
        }
        document.addEventListener('pointerdown', closeOnOutside)
        document.addEventListener('keydown', closeOnEscape)
        return function () {
          document.removeEventListener('pointerdown', closeOnOutside)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [filterMenuOpen])

      if (!loaded) return null

      var selected = null
      for (var index = 0; index < records.length; index += 1) {
        if (records[index].turn === selectedTurn) { selected = records[index]; break }
      }
      if (selected === null && records.length > 0) selected = records[records.length - 1]

      // Non-resident mode is an activity dock, not a permanent panel: show it
      // only while there is a checkpoint that still needs attention. Once the
      // user keeps or undoes everything, history stays reachable in Settings.
      if (!settings.resident && !records.some(function (record) {
        return record.status === 'open' || record.status === 'sealed'
      })) return null

      if (records.length === 0) {
        if (error !== '') {
          return createElement('section', { className: 'ecp_dock', 'data-checkpoint-dock': '' },
            createElement('div', { className: 'ecp_panel' },
              createElement('div', { className: 'ecp_error' }, error)))
        }
        // An empty dock is noise above the composer; show it only once this
        // session has a checkpoint. History stays available in Settings.
        return null
      }

      // Checkpoint numbers are a display ordinal inside one session: the first
      // checkpoint a session records is 1, even when its turn number is 45.
      // The turn stays the internal key for records, storage and jump targets.
      var ordinalByTurn = {}
      var chronological = records.slice().sort(function (a, b) { return a.turn - b.turn })
      for (var ordinalIndex = 0; ordinalIndex < chronological.length; ordinalIndex += 1) {
        ordinalByTurn[chronological[ordinalIndex].turn] = ordinalIndex + 1
      }
      var ordinalOf = function (record) {
        var ordinal = ordinalByTurn[record.turn]
        return typeof ordinal === 'number' ? ordinal : record.turn
      }
      var displayTurn = function (turn) {
        var ordinal = ordinalByTurn[turn]
        return typeof ordinal === 'number' ? ordinal : turn
      }
      var actionMessage = function (result, action) {
        if (!result) return t('actionFailed')
        var label = typeof result.turn === 'number' ? displayTurn(result.turn) : null
        if (result.code === 'newer-checkpoint' && label !== null) {
          return action === 'keep' ? format(t, 'keepNewer', label) : format(t, 'undoNewer', label)
        }
        if (result.code === 'newer-active' && label !== null) return format(t, 'undoNewer', label)
        if (result.code === 'accepted' && label !== null) return format(t, 'undoAccepted', label)
        if (result.code === 'earlier-undone' && label !== null) return format(t, 'redoEarlier', label)
        if (result.code === 'newer-open' && label !== null) {
          if (action === 'keep') return format(t, 'keepOpenLater', label)
          if (action === 'revert') return format(t, 'revertOpenLater', label)
          return format(t, 'undoOpenLater', label)
        }
        if (result.code === 'kept') return t('undoKept')
        if (result.code === 'not-ready') return t('undoRecording')
        return result.message || t('actionFailed')
      }

      var selectedStatus = selected.status
      var recording = selectedStatus === 'open'
      var sealed = selectedStatus === 'sealed'
      var files = Array.isArray(selected.files) ? selected.files : []
      var visibleFiles = showAllFiles ? files : files.slice(0, 4)
      var hiddenFiles = files.length - visibleFiles.length
      var confirming = confirmTurn === selected.turn

      // Undo only moves one checkpoint back. A later checkpoint that still owns
      // a change to any of the same files must be handled first, otherwise the
      // restore would silently throw away newer work.
      var newerBlock = null
      if (sealed) {
        var selectedPaths = new Set()
        for (var selectedIndex = 0; selectedIndex < files.length; selectedIndex += 1) {
          selectedPaths.add(files[selectedIndex].path)
        }
        for (var laterIndex = 0; laterIndex < records.length; laterIndex += 1) {
          var later = records[laterIndex]
          if (later.turn <= selected.turn || later.status === 'undone') continue
          var laterFiles = Array.isArray(later.files) ? later.files : []
          for (var laterFileIndex = 0; laterFileIndex < laterFiles.length; laterFileIndex += 1) {
            if (selectedPaths.has(laterFiles[laterFileIndex].path)) { newerBlock = later; break }
          }
          if (newerBlock !== null) break
        }
      }
      var undoBlocked = newerBlock !== null
      var acceptedLater = null
      for (var acceptedIndex = records.length - 1; acceptedIndex >= 0; acceptedIndex -= 1) {
        var acceptedCandidate = records[acceptedIndex]
        if (acceptedCandidate.turn > selected.turn && acceptedCandidate.status === 'kept') {
          acceptedLater = acceptedCandidate
          break
        }
      }

      // Redo only applies to the current undone suffix, oldest first. Older
      // undone records that are already superseded by an active checkpoint must
      // not block redoing a newer one.
      var lastActiveTurn = -1
      for (var activeIndex = 0; activeIndex < records.length; activeIndex += 1) {
        if (records[activeIndex].status !== 'undone') lastActiveTurn = records[activeIndex].turn
      }
      var redoMode = selectedStatus === 'undone'
      var redoBlocker = null
      if (redoMode) {
        for (var redoIndex = 0; redoIndex < records.length; redoIndex += 1) {
          var redoCandidate = records[redoIndex]
          if (redoCandidate.turn < selected.turn && redoCandidate.turn > lastActiveTurn && redoCandidate.status === 'undone') {
            redoBlocker = { kind: 'earlier', record: redoCandidate }
            break
          }
          if (redoCandidate.turn > selected.turn && redoCandidate.status !== 'undone') {
            redoBlocker = { kind: 'newer', record: redoCandidate }
            break
          }
        }
      }
      if (redoMode && selected.contentRemoved === true) redoBlocker = { kind: 'removed', record: selected }
      var redoDisabled = busy !== '' || !redoMode || redoBlocker !== null
      var redoTitle = !redoMode
        ? t('undo')
        : selected.contentRemoved === true
          ? t('contentRemoved')
          : redoBlocker === null
            ? format(t, 'redo', selected.turn)
            : redoBlocker.kind === 'earlier'
              ? format(t, 'redoEarlier', displayTurn(redoBlocker.record.turn))
              : format(t, 'undoNewer', displayTurn(redoBlocker.record.turn))
      var undoDisabled = redoMode
        ? redoDisabled
        : busy !== '' || !sealed || undoBlocked || acceptedLater !== null
      var undoTitle = redoMode
        ? redoTitle
        : selectedStatus === 'kept'
          ? t('undoKept')
          : selectedStatus === 'open'
            ? t('undoRecording')
            : selectedStatus === 'undone'
              ? t('undoDone')
              : acceptedLater !== null
                ? format(t, 'undoAccepted', displayTurn(acceptedLater.turn))
                : undoBlocked
                  ? newerBlock.status === 'kept'
                    ? format(t, 'undoKeptLater', displayTurn(newerBlock.turn))
                    : newerBlock.status === 'open'
                      ? format(t, 'undoOpenLater', displayTurn(newerBlock.turn))
                      : format(t, 'undoNewer', displayTurn(newerBlock.turn))
                  : undefined
      var blockHint = acceptedLater !== null
        ? undoTitle
        : newerBlock === null ? '' : undoTitle

      // Keeping an older checkpoint after a newer one would make the history
      // non-linear (two check marks with unkept checkpoints in between), so
      // only the newest active checkpoint is keepable.
      var newerList = []
      for (var activeIndex = 0; activeIndex < records.length; activeIndex += 1) {
        var active = records[activeIndex]
        if (active.turn > selected.turn && active.status !== 'undone') newerList.push(active)
      }
      newerList.sort(function (left, right) { return right.turn - left.turn })
      var newerActive = newerList.length > 0 ? newerList[0] : null
      var keepDisabled = busy !== '' || !sealed || selectedStatus === 'kept' || selectedStatus === 'undone' || newerActive !== null
      var keepTitle = selectedStatus === 'kept'
        ? t('kept')
        : selectedStatus === 'open'
          ? t('undoRecording')
          : selectedStatus === 'undone'
            ? t('undoDone')
            : newerActive !== null
              ? newerActive.status === 'kept'
                ? format(t, 'keepKeptLater', displayTurn(newerActive.turn))
                : newerActive.status === 'open'
                  ? format(t, 'keepOpenLater', displayTurn(newerActive.turn))
                  : format(t, 'keepNewer', displayTurn(newerActive.turn))
              : undefined
      if (blockHint === '' && newerActive !== null && sealed) blockHint = keepTitle

      // Revert-to-here = undo every newer active checkpoint, newest first, so
      // the files end up exactly as they were at the end of the selected turn.
      var revertTarget = selectedStatus === 'sealed' || selectedStatus === 'kept'
      var revertBlocker = null
      var revertKeptCount = 0
      if (revertTarget) {
        for (var revertIndex = 0; revertIndex < newerList.length; revertIndex += 1) {
          if (newerList[revertIndex].status === 'open') {
            revertBlocker = newerList[revertIndex]
            break
          }
          if (newerList[revertIndex].status === 'kept') revertKeptCount += 1
        }
      }
      var revertDisabled = busy !== '' || !revertTarget || newerList.length === 0 || revertBlocker !== null
      var revertTitle = selectedStatus === 'open'
        ? t('revertRecording')
        : selectedStatus === 'undone'
          ? t('revertDone')
          : !revertTarget
            ? t('revertRecording')
            : newerList.length === 0
              ? t('revertLatest')
              : revertBlocker !== null
                ? format(t, 'revertOpenLater', displayTurn(revertBlocker.turn))
                : revertKeptCount > 0
                  ? format(t, 'revertKeptWarning', revertKeptCount) + '；' + format(t, 'revertTarget', displayTurn(selected.turn))
                  : format(t, 'revertTarget', displayTurn(selected.turn))

      var canPin = !recording && selected.contentRemoved !== true
      var pinDisabled = busy !== '' || pinBusy || !canPin
      var pinTitle = recording
        ? t('pinRecording')
        : selected.contentRemoved === true
          ? t('pinRemoved')
          : t('pinHint')
      var pinLabel = selected.pinned === true ? t('unpin') : t('pin')

      var diffAvailable = files.length > 0 && selected.contentRemoved !== true

      var choose = function (turn) {
        setSelectedTurn(turn)
        setConfirmTurn(null)
        setConfirmRevert(false)
        setShowAllFiles(false)
        setShowDiff(false)
        setDiff(null)
      }

      var jumpToTurn = function (turn, seq) {
        if (!getSettings().jumpToTurn) return
        var wait = function (ms) {
          return new Promise(function (resolve) { setTimeout(resolve, ms) })
        }
        var scrollToAnchor = function () {
          var selectors = [
            '[data-chat-turn="' + turn + '"]:not([hidden])',
            '[data-turn-tail="' + turn + '"]:not([hidden])',
            '[data-turn="' + turn + '"]:not([hidden])',
          ]
          for (var index = 0; index < selectors.length; index += 1) {
            var anchor = document.querySelector(selectors[index])
            if (anchor && !anchor.hidden && typeof anchor.scrollIntoView === 'function') {
              // Instant, not smooth: smooth scrolling a virtualized transcript
              // renders every intermediate turn and blocks for seconds.
              anchor.scrollIntoView({ behavior: 'auto', block: 'center' })
              return true
            }
          }
          return false
        }
        var scan = function () {
          if (scrollToAnchor()) return Promise.resolve()
          var scroller = document.querySelector('[data-conversation-scroll]')
          if (!scroller) return Promise.resolve()
          // The transcript is virtualized. If the desired turn is outside the
          // mounted window, sweep the scrollport so the virtualizer mounts the
          // rows around it before scrolling to the exact anchor.
          var steps = [1, 0.82, 0.64, 0.46, 0.28, 0.1, 0.91, 0.73, 0.55, 0.37, 0.19, 0]
          var index = 0
          var tick = function () {
            if (scrollToAnchor()) return Promise.resolve()
            if (index >= steps.length) return Promise.resolve()
            scroller.scrollTop = Math.max(0, scroller.scrollHeight * steps[index] - scroller.clientHeight / 2)
            index += 1
            return wait(70).then(tick)
          }
          return tick()
        }
        var controller = null
        try {
          var binding = props.sessions && props.sessions.binding ? props.sessions.binding(sessionId) : undefined
          controller = binding && binding.session
        } catch (failure) {}
        // Load old history page by page and yield to the browser between pages.
        // loadThrough() accumulates all pages and prepends them in one shot,
        // which blocks the UI for seconds on a fresh/refreshed session.
        var ensureHistory = function (seq) {
          if (!controller || typeof seq !== 'number' || seq <= 0) return Promise.resolve()
          if (typeof controller.baseSeq === 'number' && controller.baseSeq <= seq) return Promise.resolve()
          var pages = 0
          var waits = 0
          var next = function () {
            if (pages >= 40) return Promise.resolve()
            if (typeof controller.baseSeq === 'number' && controller.baseSeq <= seq) return Promise.resolve()
            if (controller.hasMore === false) return Promise.resolve()
            if (typeof controller.loadOlder !== 'function') {
              if (typeof controller.loadThrough !== 'function') return Promise.resolve()
              return Promise.resolve(controller.loadThrough(seq)).catch(function () {})
            }
            if (controller.loadingOlder) {
              if (waits >= 25) return Promise.resolve()
              waits += 1
              return wait(80).then(next)
            }
            var before = controller.baseSeq
            return Promise.resolve(controller.loadOlder()).catch(function () {}).then(function () {
              pages += 1
              return wait(16)
            }).then(function () {
              if (controller.baseSeq === before) return Promise.resolve()
              return next()
            })
          }
          return next()
        }
        ensureHistory(seq).then(scan).catch(scan)
      }

      var activate = function (record) {
        choose(record.turn)
        // Let the selected row paint before any history loading starts.
        setTimeout(function () { jumpToTurn(record.turn, record.seq) }, 0)
      }

      var filteredRecords = filter === 'all'
        ? records
        : records.filter(function (record) { return record.status === filter })
      var changeFilter = function (value) {
        setFilter(value)
        setVisibleLimit(30)
        var matching = value === 'all'
          ? records
          : records.filter(function (record) { return record.status === value })
        if (matching.length > 0) choose(matching[matching.length - 1].turn)
      }
      var filterOptions = [
        { value: 'all', label: t('filterAll') },
        { value: 'open', label: t('filterOpen') },
        { value: 'sealed', label: t('filterSealed') },
        { value: 'kept', label: t('filterKept') },
        { value: 'undone', label: t('filterUndone') },
      ]
      var filterLabel = filterOptions[0].label
      for (var filterOptionIndex = 0; filterOptionIndex < filterOptions.length; filterOptionIndex += 1) {
        if (filterOptions[filterOptionIndex].value === filter) {
          filterLabel = filterOptions[filterOptionIndex].label
          break
        }
      }
      var chooseFilter = function (value) {
        changeFilter(value)
        setFilterMenuOpen(false)
      }

      var runKeep = function () {
        if (busy || selectedStatus !== 'sealed' || newerActive !== null) return
        setBusy('keep')
        setError('')
        api.keep(sessionId, selected.turn).then(function (result) {
          if (!result || result.ok !== true) {
            setError(actionMessage(result, 'keep'))
            return
          }
          setShowDiff(false)
          refresh()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () { setBusy('') })
      }

      var runUndo = function () {
        if (redoMode) {
          if (redoDisabled) return
          setBusy('redo')
          setError('')
          api.undo(sessionId, selected.turn).then(function (result) {
            if (!result || result.ok !== true) {
              setError(actionMessage(result, 'undo'))
              return
            }
            setShowDiff(false)
            refresh()
          }).catch(function (failure) {
            setError(failure && failure.message ? failure.message : t('actionFailed'))
          }).finally(function () { setBusy('') })
          return
        }
        if (undoDisabled) return
        if (!confirming) {
          setConfirmTurn(selected.turn)
          return
        }
        setConfirmTurn(null)
        setBusy('undo')
        setError('')
        api.undo(sessionId, selected.turn).then(function (result) {
          if (!result || result.ok !== true) {
            setError(actionMessage(result, 'undo'))
            return
          }
          setShowDiff(false)
          refresh()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () { setBusy('') })
      }

      var runRevert = function () {
        if (revertDisabled) {
          // A polling refresh can turn a target into the latest / blocked while
          // the first click is still armed; do not execute a stale confirmation.
          setConfirmRevert(false)
          return
        }
        if (!confirmRevert) {
          setConfirmRevert(true)
          setConfirmTurn(null)
          return
        }
        setConfirmRevert(false)
        setBusy('revert')
        setError('')
        // One Host call: the store preflights the whole newer chain before any
        // file write, so a conflict in a later checkpoint cannot leave a half
        // reverted workspace. A negative turn selects the revert path.
        api.undo(sessionId, -selected.turn).then(function (result) {
          if (!result || result.ok !== true) {
            throw new Error(actionMessage(result, 'revert'))
          }
          setBusy('')
          setSelectedTurn(selected.turn)
          refresh()
        }).catch(function (failure) {
          setBusy('')
          setSelectedTurn(selected.turn)
          setError(failure && failure.message ? failure.message : t('revertFailed'))
          refresh()
        })
      }

      var review = function (fileIndex) {
        if (!openReview || !selected.seq) return
        try {
          openReview({ sessionId: sessionId, seq: selected.seq, turn: selected.turn }, fileIndex)
        } catch (failure) {
          setError(failure && failure.message ? failure.message : String(failure))
        }
      }

      var toggleDiff = function () {
        if (diffLoading) return
        if (showDiff) {
          setShowDiff(false)
          return
        }
        setShowDiff(true)
        setDiffLoading(true)
        setError('')
        api.diff(sessionId, selected.turn).then(function (result) {
          setDiff(result)
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () {
          setDiffLoading(false)
        })
      }

      var runPin = function () {
        if (pinDisabled) return
        setPinBusy(true)
        setError('')
        api.pin(sessionId, selected.turn).then(function (result) {
          if (!result || result.ok !== true) {
            setError(result && result.message ? result.message : t('actionFailed'))
            return
          }
          refresh()
          if (showStorage) loadStats()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () {
          setPinBusy(false)
        })
      }

      var runClean = function () {
        if (confirmClean !== true) {
          setConfirmClean(true)
          return
        }
        setConfirmClean(false)
        setBusy('clean')
        setError('')
        api.clean(sessionId).then(function (result) {
          if (!result || result.ok !== true) {
            setError(result && result.message ? result.message : t('actionFailed'))
            return
          }
          loadStats()
          refresh()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () { setBusy('') })
      }

      var runPurge = function () {
        if (confirmPurge !== true) {
          setConfirmPurge(true)
          return
        }
        setConfirmPurge(false)
        setBusy('purge')
        setError('')
        api.purgeOrphans(sessionId).then(function (result) {
          if (!result || result.ok !== true) {
            setError(result && result.message ? result.message : t('actionFailed'))
            return
          }
          if ((result.records || 0) === 0) setError(t('purgeNothing'))
          else setError(fill(t, 'purgeDone', { records: result.records || 0, size: formatSize(result.bytes || 0) }))
          loadStats()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () { setBusy('') })
      }

      var saveConfig = function (patch) {
        setBusy('config')
        setError('')
        api.setConfig(patch).then(function (result) {
          if (!result || result.ok !== true) {
            setError(result && result.message ? result.message : t('actionFailed'))
            return
          }
          setStats(function (current) {
            if (current === null) return current
            var next = {}
            for (var key in current) next[key] = current[key]
            next.autoClean = result.autoClean === true
            next.keepRecent = result.keep
            return next
          })
          loadStats()
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('actionFailed'))
        }).finally(function () { setBusy('') })
      }

      var runReview = function () {
        review(0)
      }

      var fileRow = function (file, fileIndex) {
        var clickable = typeof openReview === 'function' && !!selected.seq
        return createElement('li', { key: file.path + ':' + fileIndex }, createElement('button', {
          type: 'button',
          className: 'ecp_file',
          title: file.path,
          onClick: clickable
            ? function () { review(fileIndex) }
            : undefined,
          disabled: !clickable,
        }, [
          createElement('span', { key: 'e', className: 'ecp_ext' }, extensionOf(file.path)),
          createElement('span', { key: 'p', className: 'ecp_filePath' }, file.path),
          createElement('span', { key: 'c', className: 'ecp_fileCounts' },
            file.binary
              ? createElement('span', { key: 'b' }, t('binary'))
              : [
                  createElement('span', { key: 'a', className: 'ecp_add' }, '+' + String(file.added || 0)),
                  createElement('span', { key: 'd', className: 'ecp_del' }, '-' + String(file.deleted || 0)),
                ]),
        ]))
      }

      var checkpointRow = function (record, rowIndex) {
        var chosen = record.turn === selected.turn
        var status = record.status
        var right
        if (status === 'kept') {
          right = createElement('span', { className: 'ecp_cpCheck' }, checkIcon())
        } else if (status === 'undone') {
          right = createElement('span', { className: 'ecp_cpState' }, t('undone'))
        } else if (status === 'open') {
          right = createElement('span', { className: 'ecp_cpState' }, t('recording'))
        } else {
          right = [
            createElement('span', { key: 'a', className: 'ecp_add' }, '+' + String(record.added || 0)),
            createElement('span', { key: 'd', className: 'ecp_del' }, '-' + String(record.deleted || 0)),
          ]
        }
        return createElement('button', {
          key: record.turn + ':' + rowIndex,
          type: 'button',
          className: 'ecp_cp',
          'data-selected': chosen ? 'true' : 'false',
          'data-status': status,
          onClick: function () { activate(record) },
        }, [
          createElement('span', { key: 'main', className: 'ecp_cpMain' }, [
            createElement('span', { key: 'title', className: 'ecp_cpTitle', title: format(t, 'rawTurn', record.turn) }, [
              format(t, 'title', ordinalOf(record)),
              record.recovered ? createElement('span', { key: 'rec', className: 'ecp_status' }, t('recovered')) : null,
              record.pinned ? createElement('span', { key: 'pin', className: 'ecp_pinPill' }, t('pinned')) : null,
            ]),
            createElement('span', { key: 'prompt', className: 'ecp_cpPrompt', title: record.prompt || '' },
              record.prompt || t('defaultPrompt')),
          ]),
          createElement('span', { key: 'right', className: 'ecp_cpRight' }, right),
        ])
      }

      var statusLabel = recording
        ? t('recording')
        : selectedStatus === 'kept'
          ? t('kept')
          : selectedStatus === 'undone'
            ? t('undone')
            : ''

      var ordered = filteredRecords.slice().reverse()
      var pageRecords = ordered.slice(0, Math.max(30, visibleLimit))
      var hiddenRecords = ordered.length - pageRecords.length

      var patchLine = function (line, lineIndex) {
        if (line.indexOf('@@') === 0) {
          return createElement('li', { key: 'h' + lineIndex, className: 'ecp_patchLine ecp_patchMeta' }, line)
        }
        var kind = line.charAt(0)
        var extra = kind === '+' ? ' ecp_patchAdd' : kind === '-' ? ' ecp_patchDel' : ''
        return createElement('li', { key: 'l' + lineIndex, className: 'ecp_patchLine' + extra }, line)
      }

      var diffPanel = null
      if (showDiff) {
        var diffChildren = []
        if (diffLoading) {
          diffChildren.push(createElement('div', { key: 'loading', className: 'ecp_patchMeta' }, t('diffLoading')))
        } else if (diff === null) {
          diffChildren.push(createElement('div', { key: 'empty', className: 'ecp_patchMeta' }, t('diffUnavailable')))
        } else if (diff.ok !== true) {
          diffChildren.push(createElement('div', { key: 'failed', className: 'ecp_patchMeta' },
            diff.message ? diff.message : t('diffUnavailable')))
        } else {
          var diffFiles = Array.isArray(diff.files) ? diff.files : []
          if (diffFiles.length === 0) {
            diffChildren.push(createElement('div', { key: 'none', className: 'ecp_patchMeta' }, t('diffEmpty')))
          }
          for (var diffFileIndex = 0; diffFileIndex < diffFiles.length; diffFileIndex += 1) {
            var diffFile = diffFiles[diffFileIndex]
            var body
            if (diffFile.binary) {
              body = createElement('div', { className: 'ecp_patchMeta' }, t('diffBinary'))
            } else if (!diffFile.available) {
              body = createElement('div', { className: 'ecp_patchMeta' }, t('diffUnavailable'))
            } else if (!diffFile.patch) {
              body = createElement('div', { className: 'ecp_patchMeta' }, t('diffEmpty'))
            } else {
              body = createElement('ul', { className: 'ecp_patch' },
                diffFile.patch.split('\n').map(patchLine))
            }
            diffChildren.push(createElement('div', { key: diffFile.path + ':' + diffFileIndex, className: 'ecp_diffFile' }, [
              createElement('div', { key: 'head', className: 'ecp_diffHead' }, [
                createElement('span', { key: 'path', className: 'ecp_filePath' }, diffFile.path),
                createElement('span', { key: 'counts', className: 'ecp_fileCounts' }, [
                  createElement('span', { key: 'a', className: 'ecp_add' }, '+' + String(diffFile.added || 0)),
                  createElement('span', { key: 'd', className: 'ecp_del' }, '-' + String(diffFile.deleted || 0)),
                ]),
              ]),
              diffFile.truncated ? createElement('div', { key: 'trunc', className: 'ecp_patchMeta' }, t('diffTruncated')) : null,
              body,
            ]))
          }
        }
        diffPanel = createElement('div', { key: 'diff', className: 'ecp_diff', 'data-checkpoint-diff': '' }, diffChildren)
      }

      var storagePanel = null
      if (showStorage) {
        var storageBody
        if (stats === null) {
          storageBody = createElement('div', null, t('diffLoading'))
        } else {
          var summary = String(t('storageSummary'))
            .replace('{n}', String(stats.records || 0))
            .replace('{size}', formatSize(stats.bytes))
            .replace('{cleanable}', String(stats.cleanable || 0))
          storageBody = createElement('div', null, [
            createElement('div', { key: 'title', className: 'ecp_storageTitle' }, t('storageTitle')),
            createElement('div', { key: 'sum' }, summary),
            createElement('div', { key: 'pinned' }, format(t, 'storagePinned', stats.pinned || 0)),
            createElement('div', { key: 'policy' }, format(t, 'storagePolicy', stats.keepRecent || 30)),
            createElement('div', { key: 'auto', className: 'ecp_storageSetting' }, [
              createElement('label', { key: 'toggle', className: 'ecp_storageToggle' }, [
                createElement('input', {
                  key: 'box',
                  type: 'checkbox',
                  className: 'ecp_storageCheck',
                  checked: stats.autoClean === true,
                  disabled: busy !== '',
                  onChange: function (event) { saveConfig({ autoClean: event.target.checked === true }) },
                }),
                createElement('span', { key: 'text' }, t('storageAutoClean')),
              ]),
              createElement('label', { key: 'keep', className: 'ecp_storageToggle' }, [
                createElement('span', { key: 'text' }, t('storageKeep')),
                createElement('select', {
                  key: 'select',
                  className: 'ecp_storageSelect',
                  value: String(stats.keepRecent || 30),
                  disabled: busy !== '',
                  onChange: function (event) { saveConfig({ keep: Number(event.target.value) }) },
                }, [10, 20, 30, 50, 100, 200].map(function (option) {
                  return createElement('option', { key: option, value: String(option) },
                    format(t, 'storageKeepOption', option))
                })),
              ]),
            ]),
            createElement('div', { key: 'row', className: 'ecp_storageRow' }, [
              createElement('span', { key: 'cleanable' },
                String(stats.cleanableBytes ? formatSize(stats.cleanableBytes) : '0 B')),
              createElement('button', {
                key: 'clean',
                type: 'button',
                className: 'ecp_btn' + (confirmClean ? ' is-confirm' : ''),
                disabled: busy !== '' || (stats.cleanable || 0) === 0,
                onClick: runClean,
              }, confirmClean ? t('confirmClean') : t('clean')),
            ]),
            stats.failure ? createElement('div', { key: 'failure', className: 'ecp_storageWarn' },
              fill(t, 'storageFailure', { message: stats.failure.message })) : null,
            stats.orphans && (stats.orphans.sessions || 0) > 0 ? createElement('div', { key: 'orphans', className: 'ecp_storageOrphans' }, [
              createElement('div', { key: 'line', className: 'ecp_storageOrphanText' },
                fill(t, 'storageOrphans', {
                  sessions: stats.orphans.sessions || 0,
                  records: stats.orphans.records || 0,
                  size: formatSize(stats.orphans.bytes || 0),
                })),
              createElement('div', { key: 'hint', className: 'ecp_storageHint' }, t('storageOrphanHint')),
              createElement('button', {
                key: 'purge',
                type: 'button',
                className: 'ecp_btn' + (confirmPurge ? ' is-confirm' : ''),
                disabled: busy !== '',
                onClick: runPurge,
              }, confirmPurge ? t('confirmPurge') : t('purgeOrphans')),
            ]) : null,
          ])
        }
        storagePanel = createElement('div', { key: 'storage', className: 'ecp_storage', 'data-checkpoint-storage': '' }, storageBody)
      }

      return createElement('section', {
        className: 'ecp_dock',
        'data-checkpoint-dock': '',
      }, createElement('div', {
        className: 'ecp_panel',
        'data-collapsed': collapsed ? 'true' : 'false',
        'data-menu-open': filterMenuOpen ? 'true' : 'false',
      }, [
        createElement('button', {
          key: 'head',
          type: 'button',
          className: 'ecp_head',
          'aria-expanded': collapsed ? 'false' : 'true',
          onClick: function () { setCollapsed(!collapsed) },
        }, [
          createElement('span', { key: 'icon', className: 'ecp_headIcon' }, checkpointIcon(15)),
          createElement('span', { key: 'title', className: 'ecp_headTitle' }, t('checkpoints')),
          createElement('span', { key: 'count', className: 'ecp_headCount' },
            format(t, 'count', filteredRecords.length)),
          createElement('span', { key: 'chev', className: 'ecp_chev' }, chevron()),
        ]),
        collapsed ? null : createElement('div', { key: 'filterRow', className: 'ecp_filterRow' }, [
          createElement('span', { key: 'label', className: 'ecp_filterLabel' }, t('filter')),
          createElement('div', { key: 'picker', className: 'ecp_sessionPicker ecp_filterPicker', ref: filterPickerRef }, [
            createElement('button', {
              key: 'button',
              type: 'button',
              className: 'ecp_sessionButton' + (filterMenuOpen ? ' is-open' : ''),
              'aria-haspopup': 'listbox',
              'aria-expanded': filterMenuOpen,
              onClick: function () { setFilterMenuOpen(!filterMenuOpen) },
            }, [
              createElement('span', { key: 'text', className: 'ecp_sessionButtonText' }, filterLabel),
              createElement('span', { key: 'chevron', className: 'ecp_sessionChevron' }, filterMenuOpen ? '▴' : '▾'),
            ]),
            filterMenuOpen ? createElement('div', { key: 'menu', className: 'ecp_sessionMenu ecp_filterMenu', role: 'listbox' },
              filterOptions.map(function (option) {
                var active = filter === option.value
                return createElement('button', {
                  key: option.value,
                  type: 'button',
                  role: 'option',
                  'aria-selected': active,
                  className: 'ecp_sessionOption' + (active ? ' is-active' : ''),
                  onClick: function () { chooseFilter(option.value) },
                }, [
                  createElement('span', { key: 'text', className: 'ecp_sessionOptionText' }, option.label),
                  active ? createElement('span', { key: 'check', className: 'ecp_sessionCheck' }, '✓') : null,
                ])
              })) : null,
          ]),
        ]),
        collapsed ? null : (ordered.length === 0
          ? createElement('div', { key: 'cpsEmpty', className: 'ecp_empty' }, t('filterEmpty'))
          : createElement('div', { key: 'cps', className: 'ecp_cps' }, pageRecords.map(checkpointRow))),
        collapsed || hiddenRecords <= 0 ? null : createElement('button', {
          key: 'moreCheckpoints',
          type: 'button',
          className: 'ecp_more',
          onClick: function () { setVisibleLimit(visibleLimit + 30) },
        }, format(t, 'loadMore', Math.min(30, hiddenRecords))),
        collapsed || ordered.length === 0 ? null : createElement('ul', { key: 'files', className: 'ecp_files' },
          visibleFiles.map(fileRow)),
        collapsed || ordered.length === 0 || files.length <= 4 ? null : createElement('button', {
          key: 'more',
          type: 'button',
          className: 'ecp_more',
          onClick: function () { setShowAllFiles(function (value) { return !value }) },
        }, showAllFiles ? t('less') : format(t, 'more', files.length - 4)),
        collapsed || ordered.length === 0 ? null : diffPanel,
        collapsed || ordered.length === 0 ? null : createElement('div', { key: 'foot', className: 'ecp_foot' }, [
          createElement('span', { key: 'meta', className: 'ecp_meta' }, [
            format(t, 'files', files.length),
            ' · ',
            format(t, 'title', ordinalOf(selected)),
            statusLabel === '' ? '' : ' · ' + statusLabel,
            selected.pinned ? ' · ' + t('pinned') : '',
            selected.contentRemoved ? ' · ' + t('contentRemoved') : '',
            blockHint === '' ? '' : ' · ' + blockHint,
          ]),
          createElement('span', { key: 'actions', className: 'ecp_actions' }, [
            createElement('button', {
              key: 'keep',
              type: 'button',
              className: 'ecp_btn ecp_keep',
              disabled: keepDisabled,
              title: keepTitle,
              onClick: runKeep,
            }, t('keep')),
            createElement('button', {
              key: 'undo',
              type: 'button',
              className: 'ecp_btn ecp_undo' + (confirming ? ' is-confirm' : ''),
              disabled: undoDisabled,
              title: undoTitle,
              onClick: runUndo,
            }, redoMode ? t('redo') : (confirming ? t('confirmUndo') : t('undo'))),
            createElement('button', {
              key: 'revert',
              type: 'button',
              className: 'ecp_btn ecp_revert' + (confirmRevert ? ' is-confirm' : ''),
              disabled: revertDisabled,
              title: revertTitle,
              onClick: runRevert,
            }, confirmRevert ? t('confirmRevert') : t('revert')),
            createElement('button', {
              key: 'pin',
              type: 'button',
              className: 'ecp_btn' + (selected.pinned ? ' ecp_keep' : ''),
              disabled: pinDisabled,
              title: pinTitle,
              onClick: runPin,
            }, pinLabel),
            createElement('button', {
              key: 'diff',
              type: 'button',
              className: 'ecp_btn' + (showDiff ? ' ecp_keep' : ''),
              disabled: busy !== '' || !diffAvailable,
              onClick: toggleDiff,
            }, showDiff ? t('hideDiff') : t('diff')),
            createElement('button', {
              key: 'storage',
              type: 'button',
              className: 'ecp_btn',
              onClick: function () { setShowStorage(!showStorage) },
            }, t('storage')),
          ]),
        ]),
        collapsed ? null : storagePanel,
        error === '' ? null : createElement('div', { key: 'error', className: 'ecp_error' }, error),
      ]))
    }

    // --- Settings section (a top-level item in the Settings sidebar). ---
    function CheckpointSettingsIcon(props) {
      return createElement(primitives.IconDeliverDocRegular, { size: props.size || 16 })
    }

    function CheckpointSettingsTab(props) {
      var t = props.t || function (key) { return key }
      var api = props.api
      var openReview = props.openReview
      var state = useState(getSettings())
      var settings = state[0]
      var setSettings = state[1]
      var tabState = useState('overview')
      var tab = tabState[0]
      var setTab = tabState[1]
      var filterState = useState('all')
      var overviewFilter = filterState[0]
      var setOverviewFilter = filterState[1]
      var sessionState = useState('all')
      var sessionFilter = sessionState[0]
      var setSessionFilter = sessionState[1]
      var historyState = useState([])
      var history = historyState[0]
      var setHistory = historyState[1]
      var loadingState = useState(true)
      var loading = loadingState[0]
      var setLoading = loadingState[1]
      var errorState = useState('')
      var error = errorState[0]
      var setError = errorState[1]
      var sessionMenuState = useState(false)
      var sessionMenuOpen = sessionMenuState[0]
      var setSessionMenuOpen = sessionMenuState[1]
      var sessionPickerRef = useRef(null)

      useEffect(function () {
        if (!sessionMenuOpen) return undefined
        var closeOnOutside = function (event) {
          if (sessionPickerRef.current && !sessionPickerRef.current.contains(event.target)) setSessionMenuOpen(false)
        }
        var closeOnEscape = function (event) {
          if (event.key === 'Escape') setSessionMenuOpen(false)
        }
        document.addEventListener('pointerdown', closeOnOutside)
        document.addEventListener('keydown', closeOnEscape)
        return function () {
          document.removeEventListener('pointerdown', closeOnOutside)
          document.removeEventListener('keydown', closeOnEscape)
        }
      }, [sessionMenuOpen])

      useEffect(function () {
        return subscribeSettings(function (next) { setSettings(next) })
      }, [])

      var loadHistory = useCallback(function () {
        if (!api) {
          setLoading(false)
          return
        }
        setLoading(true)
        api.listAll().then(function (list) {
          setHistory(Array.isArray(list) ? list : [])
          setError('')
        }).catch(function (failure) {
          setError(failure && failure.message ? failure.message : t('historyLoadFailed'))
        }).then(function () {
          setLoading(false)
        })
      }, [api])

      useEffect(function () { loadHistory() }, [loadHistory])

      var row = function (key, label, hint) {
        return createElement('label', { key: key, className: 'ecp_settingRow' }, [
          createElement('span', { key: 'text', className: 'ecp_settingText' }, [
            createElement('span', { key: 'label', className: 'ecp_settingLabel' }, label),
            createElement('span', { key: 'hint', className: 'ecp_settingHint' }, hint),
          ]),
          createElement('input', {
            key: 'input',
            type: 'checkbox',
            className: 'ecp_toggle',
            checked: !!settings[key],
            onChange: function () {
              var patch = {}
              patch[key] = !settings[key]
              updateSettings(patch)
            },
          }),
        ])
      }

      var statusText = function (record) {
        if (record.status === 'open') return t('recording')
        if (record.status === 'kept') return t('kept')
        if (record.status === 'undone') return t('undone')
        return t('filterSealed')
      }

      // Display numbering is per session, not the raw DSH turn number. A
      // session whose first file change happened on turn 45 still shows
      // 检查点 1. The turn remains the internal key for records and jumps.
      var ordinalByKey = {}
      var ordinalCounts = {}
      var earliestBySession = {}
      var chronologicalHistory = history.slice().sort(function (a, b) {
        var left = String(a.sessionId || '')
        var right = String(b.sessionId || '')
        if (left !== right) return left < right ? -1 : 1
        return a.turn - b.turn
      })
      for (var ordinalIndex = 0; ordinalIndex < chronologicalHistory.length; ordinalIndex += 1) {
        var ordinalRecord = chronologicalHistory[ordinalIndex]
        var ordinalSession = String(ordinalRecord.sessionId || '')
        if (!earliestBySession[ordinalSession]) earliestBySession[ordinalSession] = ordinalRecord
        ordinalCounts[ordinalSession] = (ordinalCounts[ordinalSession] || 0) + 1
        ordinalByKey[ordinalSession + ':' + ordinalRecord.turn] = ordinalCounts[ordinalSession]
      }
      var ordinalOf = function (record) {
        var ordinal = ordinalByKey[String(record.sessionId || '') + ':' + record.turn]
        return typeof ordinal === 'number' ? ordinal : record.turn
      }

      var sessionLabel = function (record) {
        var explicit = record && record.sessionTitle ? String(record.sessionTitle).replace(/\\s+/g, ' ').trim() : ''
        if (explicit !== '') return explicit.length > 48 ? explicit.slice(0, 47) + '…' : explicit
        var cwd = String(record.cwd || '')
        var base = cwd.split(/[\\/]/).filter(Boolean).pop() || ''
        var id = String(record.sessionId || '')
        var first = earliestBySession[id]
        var prompt = first && first.prompt ? String(first.prompt).replace(/\s+/g, ' ').trim() : ''
        if (prompt !== '') return prompt.length > 48 ? prompt.slice(0, 47) + '…' : prompt
        return base || id.replace(/^session-/, '').slice(0, 8)
      }

      var historyRow = function (record) {
        var reason = ''
        if (record.status === 'open') reason = t('historyNoIndex')
        var files = Array.isArray(record.files) ? record.files : []
        return createElement('div', { key: record.sessionId + ':' + record.turn, className: 'ecp_histRow' }, [
          createElement('div', { key: 'main', className: 'ecp_histMain' }, [
            createElement('div', { key: 'line', className: 'ecp_histTitleLine' }, [
              createElement('span', { key: 'title', className: 'ecp_histTitle', title: format(t, 'rawTurn', record.turn) }, format(t, 'title', ordinalOf(record))),
              createElement('span', { key: 'status', className: 'ecp_histStatus' }, statusText(record)),
              createElement('span', { key: 'session', className: 'ecp_sessionTag' }, sessionLabel(record)),
              record.pinned ? createElement('span', { key: 'pin', className: 'ecp_pinPill' }, t('pinned')) : null,
            ]),
            createElement('div', { key: 'prompt', className: 'ecp_histPrompt' }, record.prompt || t('defaultPrompt')),
            createElement('div', { key: 'meta', className: 'ecp_histMeta' }, [
              format(t, 'historyFiles', files.length),
              ' · ',
              createElement('span', { key: 'a', className: 'ecp_add' }, '+' + String(record.added || 0)),
              createElement('span', { key: 'd', className: 'ecp_del' }, '-' + String(record.deleted || 0)),
            ]),
            reason === '' ? null : createElement('div', { key: 'reason', className: 'ecp_histReason' }, reason),
          ]),
          createElement('button', {
            key: 'review',
            type: 'button',
            className: 'ecp_btn',
            disabled: !openReview || record.seq <= 0,
            onClick: function () {
              try {
                openReview(record, 0)
              } catch (failure) {
                setError(failure && failure.message ? failure.message : t('actionFailed'))
              }
            },
          }, t('review')),
        ])
      }

      var sessionOptions = []
      history.forEach(function (record) {
        var id = String(record.sessionId || '')
        if (!id) return
        for (var index = 0; index < sessionOptions.length; index += 1) {
          if (sessionOptions[index].id === id) return
        }
        sessionOptions.push({ id: id, label: sessionLabel(record) + ' · ' + format(t, 'count', ordinalCounts[id] || 0) })
      })
      var currentSessionLabel = t('allSessions')
      for (var optionIndex = 0; optionIndex < sessionOptions.length; optionIndex += 1) {
        if (sessionOptions[optionIndex].id === sessionFilter) {
          currentSessionLabel = sessionOptions[optionIndex].label
          break
        }
      }
      var chooseSession = function (id) {
        setSessionFilter(id)
        setSessionMenuOpen(false)
      }
      var sessionOption = function (id, label) {
        var active = sessionFilter === id
        return createElement('button', {
          key: id,
          type: 'button',
          role: 'option',
          'aria-selected': active,
          className: 'ecp_sessionOption' + (active ? ' is-active' : ''),
          onClick: function () { chooseSession(id) },
        }, [
          createElement('span', { key: 'text', className: 'ecp_sessionOptionText' }, label),
          active ? createElement('span', { key: 'check', className: 'ecp_sessionCheck' }, '✓') : null,
        ])
      }
      var scopeHistory = sessionFilter === 'all'
        ? history
        : history.filter(function (record) { return String(record.sessionId || '') === sessionFilter })

      var counts = { all: scopeHistory.length, pending: 0, kept: 0, undone: 0 }
      scopeHistory.forEach(function (record) {
        if (record.status === 'kept') counts.kept += 1
        else if (record.status === 'undone') counts.undone += 1
        else counts.pending += 1
      })
      var summaryChip = function (key, label, count) {
        return createElement('button', {
          key: key,
          type: 'button',
          className: 'ecp_summaryChip' + (overviewFilter === key ? ' is-active' : ''),
          onClick: function () { setOverviewFilter(key) },
        }, [
          createElement('span', { key: 'label', className: 'ecp_summaryLabel' }, label),
          createElement('span', { key: 'count', className: 'ecp_summaryCount' }, String(count)),
        ])
      }
      var visibleHistory = overviewFilter === 'all'
        ? scopeHistory
        : scopeHistory.filter(function (record) {
          if (overviewFilter === 'pending') return record.status === 'open' || record.status === 'sealed'
          return record.status === overviewFilter
        })
      visibleHistory = visibleHistory.slice().sort(function (a, b) {
        var left = String(a.sessionId || '')
        var right = String(b.sessionId || '')
        if (left !== right) return left < right ? -1 : 1
        return a.turn - b.turn
      })

      var overview = createElement('div', { key: 'overview', className: 'ecp_history' }, [
        createElement('div', { key: 'head', className: 'ecp_historyHead' }, [
          createElement('div', { key: 'text', className: 'ecp_historyText' }, [
            createElement('div', { key: 'title', className: 'ecp_historyTitle' }, t('historyTitle')),
            createElement('div', { key: 'hint', className: 'ecp_settingsHint' }, t('historyHint')),
          ]),
          createElement('button', {
            key: 'refresh',
            type: 'button',
            className: 'ecp_btn',
            onClick: loadHistory,
          }, t('historyRefresh')),
        ]),
        createElement('div', { key: 'summary', className: 'ecp_summary' }, [
          summaryChip('all', t('filterAll'), counts.all),
          summaryChip('pending', t('summaryPending'), counts.pending),
          summaryChip('kept', t('kept'), counts.kept),
          summaryChip('undone', t('undone'), counts.undone),
        ]),
        history.length === 0 ? null : createElement('div', { key: 'sessionFilter', className: 'ecp_sessionRow' }, [
          createElement('span', { key: 'label', className: 'ecp_sessionRowLabel' }, t('sessionFilter')),
          createElement('div', { key: 'picker', className: 'ecp_sessionPicker', ref: sessionPickerRef }, [
            createElement('button', {
              key: 'button',
              type: 'button',
              className: 'ecp_sessionButton' + (sessionMenuOpen ? ' is-open' : ''),
              'aria-haspopup': 'listbox',
              'aria-expanded': sessionMenuOpen,
              onClick: function () { setSessionMenuOpen(!sessionMenuOpen) },
            }, [
              createElement('span', { key: 'text', className: 'ecp_sessionButtonText' }, currentSessionLabel),
              createElement('span', { key: 'chevron', className: 'ecp_sessionChevron' }, sessionMenuOpen ? '▴' : '▾'),
            ]),
            sessionMenuOpen ? createElement('div', { key: 'menu', className: 'ecp_sessionMenu', role: 'listbox' }, [
              sessionOption('all', t('allSessions')),
            ].concat(sessionOptions.map(function (option) {
              return sessionOption(option.id, option.label)
            }))) : null,
          ]),
        ]),
        error === '' ? null : createElement('div', { key: 'error', className: 'ecp_error' }, error),
        loading
          ? createElement('div', { key: 'loading', className: 'ecp_diffLoading' }, t('diffLoading'))
          : (history.length === 0
              ? createElement('div', { key: 'empty', className: 'ecp_empty' }, t('historyEmpty'))
              : (visibleHistory.length === 0
                  ? createElement('div', { key: 'empty', className: 'ecp_empty' }, t('filterEmpty'))
                  : createElement('div', { key: 'rows', className: 'ecp_histRows' }, visibleHistory.map(historyRow)))),
      ])

      var config = createElement('div', { key: 'config', className: 'ecp_settingsPane' }, [
        createElement('div', { key: 'hint', className: 'ecp_settingsHint' }, t('settingsHint')),
        row('resident', t('resident'), t('residentHint')),
        row('jumpToTurn', t('jumpToTurn'), t('jumpHint')),
        createElement('div', { key: 'reset', className: 'ecp_settingsFooter' }, [
          createElement('button', {
            key: 'button',
            type: 'button',
            className: 'ecp_btn',
            onClick: function () { updateSettings({ resident: true, jumpToTurn: true }) },
          }, t('settingsReset')),
        ]),
      ])

      return createElement('div', { className: 'ecp_settings' }, [
        createElement('div', { key: 'title', className: 'ecp_settingsTitle' }, t('settingsTitle')),
        createElement('div', { key: 'tabs', className: 'ecp_tabs' }, [
          createElement('button', {
            key: 'overview',
            type: 'button',
            className: 'ecp_tab' + (tab === 'overview' ? ' is-active' : ''),
            onClick: function () { setTab('overview') },
          }, t('tabsOverview')),
          createElement('button', {
            key: 'config',
            type: 'button',
            className: 'ecp_tab' + (tab === 'config' ? ' is-active' : ''),
            onClick: function () { setTab('config') },
          }, t('tabsConfig')),
        ]),
        tab === 'overview' ? overview : config,
      ])
    }

    var name = 'dsh-checkpoint-dock'
    var inject = ['slots', 'locale', 'remote', 'sessions']

    async function apply(ctx) {
      ctx.effect(function () { return ctx.locale.register(NS, locales) }, 'dsh-checkpoint-dock: dictionaries')
      ctx.effect(function () { installStyles() }, 'dsh-checkpoint-dock: stylesheet')

      var t = ctx.locale.bind(NS)
      var remote = null
      var sidebarRight = null

      ctx.inject(['sidebarRight'], function (scope) {
        sidebarRight = scope.sidebarRight
      })
      ctx.inject(['remote.editCheckpoints'], function (scope) {
        remote = scope.remote.editCheckpoints
      })

      var call = function (method) {
        var args = Array.prototype.slice.call(arguments, 1)
        if (!remote) return Promise.reject(new Error('检查点服务尚未挂载'))
        return Promise.resolve(remote[method].apply(remote, args)).then(unwrap)
      }

      var api = {
        get: function (sessionId, turn) { return call('get', sessionId, turn) },
        list: function (sessionId) {
          // `get(sessionId, 0)` is the compatibility path for the list: the
          // gateway routes are fixed at boot, so a brand-new method would 404
          // until DSH restarts.
          return call('get', sessionId, 0).then(function (result) {
            if (Array.isArray(result)) return result
            return result && Array.isArray(result.records) ? result.records : []
          }).catch(function (failure) {
            // The dock mounts before the Remote namespace finishes mounting;
            // an empty list keeps the first poll quiet.
            if (failure && String(failure.message || '').indexOf('尚未挂载') >= 0) return []
            throw failure
          })
        },
        keep: function (sessionId, turn) { return call('keep', sessionId, turn) },
        undo: function (sessionId, turn) { return call('undo', sessionId, turn) },
        // `*` is the all-session sentinel for the Settings history page. It
        // reuses the boot-time list route, so it works without a restart.
        listAll: function () {
          return call('get', '*', 0).then(function (result) {
            if (Array.isArray(result)) return result
            return result && Array.isArray(result.records) ? result.records : []
          })
        },
        // The gateway routes are fixed at boot. These helpers reuse the three
        // registered routes with sentinels until a restart exposes real methods.
        diff: function (sessionId, turn) { return call('get', sessionId, -turn) },
        stats: function (sessionId) { return call('get', sessionId, -999999) },
        pin: function (sessionId, turn) { return call('keep', sessionId, -turn) },
        clean: function (sessionId) { return call('undo', sessionId, -999999) },
        purgeOrphans: function (sessionId) { return call('undo', sessionId, -999998) },
        // Settings ride the get/undo routes: the gateway only ever passes
        // (sessionId, turn), so the patch travels as a JSON string in the
        // sessionId slot with its own sentinel turn.
        getConfig: function () { return call('get', 'config:', -999997) },
        setConfig: function (patch) { return call('undo', 'config:' + JSON.stringify(patch), -999997) },
      }

      var openReview = function (coordinates, index) {
        if (!sidebarRight || typeof sidebarRight.openResource !== 'function') {
          throw new Error('sidebarRight is unavailable')
        }
        var address = 'dsh-resource://changes-review/session/'
          + encodeURIComponent(coordinates.sessionId) + '/'
          + coordinates.seq + '/' + coordinates.turn
        sidebarRight.openResource(address, { params: { index: index } })
      }

      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: PACKAGE,
          order: 100,
          locale: NS,
          inject: function (sessionId) {
            return { api: api, t: t, openReview: openReview, sessionId: sessionId, sessions: ctx.sessions }
          },
        }, EditCheckpointsDock)
      })

      ctx.slots.inject('settings.section.icon', function () {
        return ctx.slots.register({
          name: 'settings.section.icon',
          id: PACKAGE,
          order: 35,
          locale: NS,
        }, CheckpointSettingsIcon)
      })

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: PACKAGE,
          order: 35,
          label: function () { return t('settingsTab') },
          locale: NS,
          inject: function () { return { t: t, api: api, openReview: openReview } },
        }, CheckpointSettingsTab)
      })

      try {
        await ctx.remote.$mount({ package: PACKAGE, descriptors: INVOCATIONS })
      } catch (failure) {
        console.error('[dsh-checkpoint-dock] remote mount failed', failure)
      }
    }

    exports.name = name
    exports.inject = inject
    exports.apply = apply
    exports.NS = NS
    return module.exports
  },
})
