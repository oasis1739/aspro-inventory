const ASPRO_SPREADSHEET_ID = '1cl-uZ9s0_VNF_YwagnujAhPTdREuzfcaPisWRRp7zwY';

function getAsproSpreadsheet_() {
  return SpreadsheetApp.openById(ASPRO_SPREADSHEET_ID);
}

function ensureSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0 && header && header.length) {
    sh.getRange(1, 1, 1, header.length).setValues([header]);
  }
  return sh;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var ss = getAsproSpreadsheet_();
    var type = (e && e.parameter && e.parameter.type) || 'health';

    if (type === 'health') {
      return json_({
        ok: true,
        spreadsheetId: ASPRO_SPREADSHEET_ID,
        updatedAt: new Date().toISOString()
      });
    }

    var matchSh = ensureSheet_(ss, 'aspro_match', ['사방넷코드','김포물류품번','상품명','메모','등록일']);
    var data = matchSh.getDataRange().getValues();
    var map = {};
    data.slice(1).forEach(function(r) {
      var sc = String(r[0] || '').trim();
      var gp = String(r[1] || '').trim();
      if (sc && gp) map[sc] = gp;
    });

    var soldoutSh = ensureSheet_(ss, 'aspro_soldout', ['사방넷코드','등록일']);
    var soldoutData = soldoutSh.getDataRange().getValues();
    var soldout = {};
    soldoutData.slice(1).forEach(function(r) {
      var sc = String(r[0] || '').trim();
      if (sc) soldout[sc] = String(r[1] || '');
    });

    return json_({
      ok: true,
      matchCount: Object.keys(map).length,
      map: type === 'base' ? map : undefined,
      soldout: type === 'base' ? soldout : undefined
    });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function processFromTemp() {
  var ss = getAsproSpreadsheet_();
  var tempSh = ss.getSheetByName('_temp_match');
  if (!tempSh) { SpreadsheetApp.getUi().alert('_temp_match 시트가 없습니다'); return; }
  var matchSh = ensureSheet_(ss, 'aspro_match', ['사방넷코드','김포물류품번','상품명','메모','등록일']);
  var existing = matchSh.getDataRange().getValues();
  var existingSet = {};
  for (var i = 1; i < existing.length; i++) {
    var c = String(existing[i][0] || '').trim();
    if (c) existingSet[c] = true;
  }
  var data = tempSh.getDataRange().getValues();
  var toAdd = [];
  var skipped = 0;
  for (var j = 0; j < data.length; j++) {
    var sc = String(data[j][0] || '').trim();
    if (!sc) continue;
    if (existingSet[sc]) { skipped++; continue; }
    toAdd.push([sc, data[j][1] || '', data[j][2] || '', data[j][3] || '', data[j][4] || new Date()]);
  }
  if (toAdd.length > 0) {
    matchSh.getRange(matchSh.getLastRow() + 1, 1, toAdd.length, 5).setValues(toAdd);
  }
  ss.deleteSheet(tempSh);
  SpreadsheetApp.getUi().alert(toAdd.length + '건 추가 완료, ' + skipped + '건 기존유지(구글시트 우선)');
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, error: 'empty post body' });
    }

    var ss = getAsproSpreadsheet_();
    var data = JSON.parse(e.postData.contents);
    var savedCount = 0;
    var now = new Date();

    if (data.map && Object.keys(data.map).length > 0) {
      var matchSh = ensureSheet_(ss, 'aspro_match', ['사방넷코드','김포물류품번','상품명','메모','등록일']);
      var lastRow = matchSh.getLastRow();
      var existing = lastRow > 1 ? matchSh.getRange(2, 1, lastRow - 1, Math.max(matchSh.getLastColumn(), 5)).getValues() : [];
      var rowIdx = {};

      for (var i = 0; i < existing.length; i++) {
        var code = String(existing[i][0] || '').trim();
        if (code) rowIdx[code] = i + 2;
      }

      var toAdd = [];
      Object.keys(data.map).forEach(function(sc) {
        sc = String(sc || '').trim();
        var gp = String(data.map[sc] || '').trim();
        if (!sc || !gp || gp === '__DELETED__') return;

        if (rowIdx[sc]) {
          matchSh.getRange(rowIdx[sc], 2).setValue(gp);
          if (matchSh.getLastColumn() >= 5) matchSh.getRange(rowIdx[sc], 5).setValue(now);
        } else {
          toAdd.push([sc, gp, '', '', now]);
        }
        savedCount++;
      });

      if (toAdd.length > 0) {
        matchSh.getRange(matchSh.getLastRow() + 1, 1, toAdd.length, 5).setValues(toAdd);
      }
    }

    if (Object.prototype.hasOwnProperty.call(data, 'soldout')) {
      var soldoutSh = ensureSheet_(ss, 'aspro_soldout', ['사방넷코드','등록일']);
      soldoutSh.clearContents();
      var soldoutRows = [['사방넷코드','등록일']];
      Object.keys(data.soldout).forEach(function(sc) {
        if (sc) soldoutRows.push([sc, data.soldout[sc] || '']);
      });
      soldoutSh.getRange(1, 1, soldoutRows.length, 2).setValues(soldoutRows);
    }

    if (data.kcfi && Object.keys(data.kcfi).length > 0) {
      var kcfiSh = ensureSheet_(ss, 'aspro_kcfi', ['사방넷코드','재고','업데이트일']);
      kcfiSh.clearContents();
      var kcfiRows = [['사방넷코드','재고','업데이트일']];
      Object.keys(data.kcfi).forEach(function(sc) {
        if (sc) kcfiRows.push([sc, data.kcfi[sc], now]);
      });
      kcfiSh.getRange(1, 1, kcfiRows.length, 3).setValues(kcfiRows);
    }

    if (data.normname && Object.keys(data.normname).length > 0) {
      var nnSh = ensureSheet_(ss, 'aspro_normname', ['정규화상품명(normName)','물류품번','원본사방넷상품명','등록일']);
      nnSh.clearContents();
      var nnRows = [['정규화상품명(normName)','물류품번','원본사방넷상품명','등록일']];
      Object.keys(data.normname).forEach(function(k) {
        if (k) nnRows.push([k, data.normname[k], '', now]);
      });
      nnSh.getRange(1, 1, nnRows.length, 4).setValues(nnRows);
    }

    if (data.forcezero && Object.keys(data.forcezero).length > 0) {
      var fzSh = ensureSheet_(ss, 'aspro_forcezero', ['자체상품코드','상품명','사방넷코드목록','등록일']);
      fzSh.clearContents();
      var fzRows = [['자체상품코드','상품명','사방넷코드목록','등록일']];
      Object.keys(data.forcezero).forEach(function(c) {
        if (c) fzRows.push([c, '', '', now]);
      });
      fzSh.getRange(1, 1, fzRows.length, 4).setValues(fzRows);
    }

    if (data.iccodemap && Object.keys(data.iccodemap).length > 0) {
      var icSh = ensureSheet_(ss, 'aspro_iccodemap', ['사방넷코드','이카운트품목코드','등록일']);
      icSh.clearContents();
      var icRows = [['사방넷코드','이카운트품목코드','등록일']];
      Object.keys(data.iccodemap).forEach(function(sc) {
        if (sc) icRows.push([sc, data.iccodemap[sc], now]);
      });
      icSh.getRange(1, 1, icRows.length, 3).setValues(icRows);
    }

    SpreadsheetApp.flush();
    return json_({ ok: true, saved: savedCount });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}
