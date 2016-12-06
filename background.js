// Copyright (c) 2012 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

var animationFrames = 36;
var animationSpeed = 10; // ms
var canvas = document.getElementById('canvas');
var loggedInImage = document.getElementById('logged_in');
var canvasContext = canvas.getContext('2d');
var pollIntervalMin = 1;  // 1 minute
var pollIntervalMax = 60;  // 1 hour
var requestTimeout = 1000 * 2;  // 2 seconds
var rotation = 0;
var loadingAnimation = new LoadingAnimation();

// Legacy support for pre-event-pages.
var oldChromeVersion = !chrome.runtime;
var requestTimerId;

function getMailUrl() {
  return "https://ndc-mail39.kp.org:4443/mail/k888858.nsf/";
}

// Identifier used to debug the possibility of multiple instances of the
// extension making requests on behalf of a single user.
function getInstanceId() {
  if (!localStorage.hasOwnProperty("instanceId"))
    localStorage.instanceId = 'gmc' + parseInt(Date.now() * Math.random(), 10);
  return localStorage.instanceId;
}

function getFeedUrl() {

  return getMailUrl() + "iNotes/Proxy/?OpenDocument&Form=s_ReadViewEntries&PresetFields="
    +encodeURIComponent("FolderName;($Inbox),UnreadCountInfo;1,s_UsingHttps;1,hc;$98,noPI;1")
    +"&TZType=UTC&Start=1&Count=17&resortdescending=5";
}

function isMailUrl(url) {
  // Return whether the URL starts with the Mail prefix.
  return url.startsWith(getMailUrl());
}

// A "loading" animation displayed while we wait for the first response from
// Mail. This animates the badge text with a dot that cycles from left to
// right.
function LoadingAnimation() {
  this.timerId_ = 0;
  this.maxCount_ = 8;  // Total number of states in animation
  this.current_ = 0;  // Current state
  this.maxDot_ = 4;  // Max number of dots in animation
}

LoadingAnimation.prototype.paintFrame = function() {
  var text = "";
  for (var i = 0; i < this.maxDot_; i++) {
    text += (i == this.current_) ? "." : " ";
  }
  if (this.current_ >= this.maxDot_)
    text += "";

  chrome.browserAction.setBadgeText({text:text});
  this.current_++;
  if (this.current_ == this.maxCount_)
    this.current_ = 0;
}

LoadingAnimation.prototype.start = function() {
  if (this.timerId_)
    return;

  var self = this;
  this.timerId_ = window.setInterval(function() {
    self.paintFrame();
  }, 100);
}

LoadingAnimation.prototype.stop = function() {
  if (!this.timerId_)
    return;

  window.clearInterval(this.timerId_);
  this.timerId_ = 0;
}

function updateIcon() {
  if (!localStorage.hasOwnProperty('unreadCount')) {
    chrome.browserAction.setIcon({path:"mail_not_logged_in.png"});
    chrome.browserAction.setBadgeBackgroundColor({color:[190, 190, 190, 230]});
    chrome.browserAction.setBadgeText({text:"?"});
  } else {
    chrome.browserAction.setIcon({path: "mail_logged_in.png"});
    chrome.browserAction.setBadgeBackgroundColor({color:[208, 0, 24, 255]});
    chrome.browserAction.setBadgeText({
      text: localStorage.unreadCount != "0" ? localStorage.unreadCount : ""
    });
  }
}

function scheduleRequest() {
  console.log('scheduleRequest');
  var randomness = Math.random() * 2;
  var exponent = Math.pow(2, localStorage.requestFailureCount || 0);
  var multiplier = Math.max(randomness * exponent, 1);
  var delay = Math.min(multiplier * pollIntervalMin, pollIntervalMax);
  delay = Math.round(delay);
  console.log('Scheduling for: ' + delay);

  if (oldChromeVersion) {
    if (requestTimerId) {
      window.clearTimeout(requestTimerId);
    }
    requestTimerId = window.setTimeout(onAlarm, delay*60*1000);
  } else {
    console.log('Creating alarm');
    // Use a repeating alarm so that it fires again if there was a problem
    // setting the next alarm.
    chrome.alarms.create('refresh', {periodInMinutes: delay});
  }
}

// ajax stuff
function startRequest(params) {
  // Schedule request immediately. We want to be sure to reschedule, even in the
  // case where the extension process shuts down while this request is
  // outstanding.
  if (params && params.scheduleRequest) scheduleRequest();

  function stopLoadingAnimation() {
    if (params && params.showLoadingAnimation) loadingAnimation.stop();
  }

  if (params && params.showLoadingAnimation)
    loadingAnimation.start();

  getInboxCount(
    function(xmlDoc) {
      stopLoadingAnimation();
      handleResultXML(xmlDoc);

    },
    function() {
      stopLoadingAnimation();
      delete localStorage.unreadCount;
      updateIcon();
    }
  );
}

function handleResultXML(xmlDoc) {
  updateBadge(xmlDoc);
  showNotification(xmlDoc);
}

function updateBadge(xmlDoc) {
  var fullCountSet = xmlDoc.evaluate("/readviewentries/unreadinfo/unreadcount",
            xmlDoc, null, XPathResult.ANY_TYPE, null);
  var fullCountNode = fullCountSet.iterateNext();
  if (fullCountNode) {
    updateUnreadCount(fullCountNode.textContent);
    return;
  } else {
    console.error(chrome.i18n.getMessage("mailcheck_node_error"));
  }
}

function showNotification(xmlDoc) {
  var fullCountSet = xmlDoc.evaluate("/readviewentries/viewentries/viewentry[@unread='true']",
           xmlDoc, null, XPathResult.ANY_TYPE, null);
  var entries = [];
  var entry;
  while (entry = fullCountSet.iterateNext()) {
    entries.push(entry);
  }

  var newmails = entries.map(parseEntry).filter(notNotifed);
  console.log(newmails);
  if(newmails.length >0 ){
    var mail1 = newmails[0];
    var opt = {
      type: "basic",
      title: "You've got new emails",
      message: mail1.from + "  " + mail1.date,
      contextMessage: mail1.title,
      iconUrl: "icon_128.png"
    }

    chrome.notifications.create(mail1.unid, opt, function() {
      newmails.map(m =>m.unid)
        .forEach(addNotifiedMail);
    });
  }

  function getNotifiedMails() {
    if(!sessionStorage.hasOwnProperty("notifiedMailIds")) {
      sessionStorage.notifiedMailIds = "";
    }
    return sessionStorage.notifiedMailIds;
  }
  function addNotifiedMail(mailId) {
    return sessionStorage.notifiedMailIds = getNotifiedMails()+";"+mailId;
  }

  function notNotifed(mail) {
    var unid = mail.unid;
    
    if(getNotifiedMails().indexOf(unid)>=0) {
      return false;
    }
    return true;
  }

  function parseEntry(viewentry) {
    var entrydatas = viewentry.children;
    var result={};
    result.unid = viewentry.attributes["unid"].value;
    for(var i = 0;i<entrydatas.length; i++) {
      var entry = entrydatas[i];
      if(entry.attributes["columnnumber"].value=="2") {
        result.from = entry.children[0].textContent;
      }
      if(entry.attributes["columnnumber"].value=="5") {
        result.date = entry.children[0].textContent;
      }
      if(entry.attributes["columnnumber"].value=="4") {
        result.title = entry.children[0].textContent;
      }
    }
    return result;

  }

}

function getInboxCount(onSuccess, onError) {
  var xhr = new XMLHttpRequest();
  var abortTimerId = window.setTimeout(function() {
    xhr.abort();  // synchronously calls onreadystatechange
  }, requestTimeout);

  function handleSuccess(xmlDoc) {
    localStorage.requestFailureCount = 0;
    window.clearTimeout(abortTimerId);
    if (onSuccess)
      onSuccess(xmlDoc);
  }

  var invokedErrorCallback = false;
  function handleError() {
    ++localStorage.requestFailureCount;
    window.clearTimeout(abortTimerId);
    if (onError && !invokedErrorCallback)
      onError();
    invokedErrorCallback = true;
  }

  try {
    xhr.onreadystatechange = function() {
      if (xhr.readyState != 4)
        return;

      if (xhr.responseXML) {
        var xmlDoc = xhr.responseXML;
        handleSuccess(xmlDoc);
        return;
      }

      handleError();
    };

    xhr.onerror = function(error) {
      handleError();
    };

    xhr.open("GET", getFeedUrl(), true);
    xhr.send(null);
  } catch(e) {
    console.error(chrome.i18n.getMessage("mailcheck_exception", e));
    handleError();
  }
}

// function mailNSResolver(prefix) {
//   if(prefix == 'mail') {
//     return 'http://purl.org/atom/ns#';
//   }
// }

function updateUnreadCount(count) {
  var changed = localStorage.unreadCount != count;
  localStorage.unreadCount = count;
  updateIcon();
  if (changed)
    animateFlip();
}


function ease(x) {
  return (1-Math.sin(Math.PI/2+x*Math.PI))/2;
}

function animateFlip() {
  rotation += 1/animationFrames;
  drawIconAtRotation();

  if (rotation <= 1) {
    setTimeout(animateFlip, animationSpeed);
  } else {
    rotation = 0;
    updateIcon();
  }
}

function drawIconAtRotation() {
  canvasContext.save();
  canvasContext.clearRect(0, 0, canvas.width, canvas.height);
  canvasContext.translate(
      Math.ceil(canvas.width/2),
      Math.ceil(canvas.height/2));
  canvasContext.rotate(2*Math.PI*ease(rotation));
  canvasContext.drawImage(loggedInImage,
      -Math.ceil(canvas.width/2),
      -Math.ceil(canvas.height/2));
  canvasContext.restore();

  chrome.browserAction.setIcon({imageData:canvasContext.getImageData(0, 0,
      canvas.width,canvas.height)});
}

function goToInbox() {
  console.log('Going to inbox...');
  chrome.tabs.getAllInWindow(undefined, function(tabs) {
    for (var i = 0, tab; tab = tabs[i]; i++) {
      if (tab.url && isMailUrl(tab.url)) {
        console.log('Found Mail tab: ' + tab.url + '. ' +
                    'Focusing and refreshing count...');
        chrome.tabs.update(tab.id, {selected: true});
        startRequest({scheduleRequest:false, showLoadingAnimation:false});
        return;
      }
    }
    console.log('Could not find Mail tab. Creating one...');
    chrome.tabs.create({url: getMailUrl()});
  });
}

function onInit() {
  console.log('onInit');
  localStorage.requestFailureCount = 0;  // used for exponential backoff
  startRequest({scheduleRequest:true, showLoadingAnimation:true});
  if (!oldChromeVersion) {
    // TODO(mpcomplete): We should be able to remove this now, but leaving it
    // for a little while just to be sure the refresh alarm is working nicely.
    chrome.alarms.create('watchdog', {periodInMinutes:5});
  }
}

function onAlarm(alarm) {
  console.log('Got alarm', alarm);
  // |alarm| can be undefined because onAlarm also gets called from
  // window.setTimeout on old chrome versions.
  if (alarm && alarm.name == 'watchdog') {
    onWatchdog();
  } else {
    startRequest({scheduleRequest:true, showLoadingAnimation:false});
  }
}

function onWatchdog() {
  chrome.alarms.get('refresh', function(alarm) {
    if (alarm) {
      console.log('Refresh alarm exists. Yay.');
    } else {
      console.log('Refresh alarm doesn\'t exist!? ' +
                  'Refreshing now and rescheduling.');
      startRequest({scheduleRequest:true, showLoadingAnimation:false});
    }
  });
}

if (oldChromeVersion) {
  updateIcon();
  onInit();
} else {
  chrome.runtime.onInstalled.addListener(onInit);
  chrome.alarms.onAlarm.addListener(onAlarm);
}

var filters = {
  // TODO(aa): Cannot use urlPrefix because all the url fields lack the protocol
  // part. See crbug.com/140238.
  url: [{urlContains: getMailUrl().replace(/^https?\:\/\//, '')}]
};

function onNavigate(details) {
  if (details.url && isMailUrl(details.url)) {
    console.log('Recognized Mail navigation to: ' + details.url + '.' +
                'Refreshing count...');
    startRequest({scheduleRequest:false, showLoadingAnimation:false});
  }
}
if (chrome.webNavigation && chrome.webNavigation.onDOMContentLoaded &&
    chrome.webNavigation.onReferenceFragmentUpdated) {
  chrome.webNavigation.onDOMContentLoaded.addListener(onNavigate, filters);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(
      onNavigate, filters);
} else {
  chrome.tabs.onUpdated.addListener(function(_, details) {
    onNavigate(details);
  });
}

chrome.browserAction.onClicked.addListener(goToInbox);

if (chrome.runtime && chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(function() {
    console.log('Starting browser... updating icon.');
    startRequest({scheduleRequest:false, showLoadingAnimation:false});
    updateIcon();
  });
} else {
  // This hack is needed because Chrome 22 does not persist browserAction icon
  // state, and also doesn't expose onStartup. So the icon always starts out in
  // wrong state. We don't actually use onStartup except as a clue that we're
  // in a version of Chrome that has this problem.
  chrome.windows.onCreated.addListener(function() {
    console.log('Window created... updating icon.');
    startRequest({scheduleRequest:false, showLoadingAnimation:false});
    updateIcon();
  });
}
