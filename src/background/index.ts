import "../common/init/extensionContext";
import isEqual from "lodash-es/isEqual";
import { ApiClient, SessionName } from "synology-typescript-api";
import {
  getHostUrl,
  onStoredStateChange,
  NotificationSettings,
  updateStateShapeIfNecessary,
} from "../common/state";
import { notify } from "../common/apis/browserUtils";
import { setSharedObjects } from "../common/apis/sharedObjects";
import { SynologyResponse, ConnectionFailure, isConnectionFailure } from "synology-typescript-api";
import { errorMessageFromCode, errorMessageFromConnectionFailure } from "../common/apis/errors";
import { maybeIsMessage, MessageHandlers, CallbackResponse } from "../common/apis/messages";
import { addDownloadTasksAndPoll, pollTasks, clearCachedTasks } from "../common/apis/actions";
import { onUnhandledError } from "../common/errorHandlers";
import { ALL_DOWNLOADABLE_PROTOCOLS, startsWithAnyProtocol } from "../common/apis/protocols";
import { assertNever } from "../common/lang";
import { filterTasks } from "../common/filtering";

const api = new ApiClient({});
const START_TIME = Date.now();

setSharedObjects({ api });

// This starts undefined, which means we haven't fetched the list of tasks yet.
let finishedTaskIds: Set<string> | undefined;

let lastNotificationSettings: NotificationSettings | undefined;
let notificationInterval: number | undefined;
let didInitializeSettings: boolean = false;

let showNonErrorNotifications: boolean = true;

browser.contextMenus.create({
  enabled: true,
  title: browser.i18n.getMessage("Download_with_DownloadStation"),
  contexts: ["link", "audio", "video", "selection"],
  onclick: (data) => {
    if (data.linkUrl) {
      addDownloadTasksAndPoll(api, showNonErrorNotifications, [data.linkUrl]);
    } else if (data.srcUrl) {
      addDownloadTasksAndPoll(api, showNonErrorNotifications, [data.srcUrl]);
    } else if (data.selectionText) {
      let urls = data.selectionText
        .split("\n")
        .map((url) => url.trim())
        // The cheapest of checks. Actual invalid URLs will be caught later.
        .filter((url) => startsWithAnyProtocol(url, ALL_DOWNLOADABLE_PROTOCOLS));

      if (urls.length == 0) {
        notify(
          browser.i18n.getMessage("Failed_to_add_download"),
          browser.i18n.getMessage("Selected_text_is_not_a_valid_URL"),
          "failure",
        );
      } else {
        addDownloadTasksAndPoll(api, showNonErrorNotifications, urls);
      }
    } else {
      notify(
        browser.i18n.getMessage("Failed_to_add_download"),
        browser.i18n.getMessage("URL_is_empty_or_missing"),
        "failure",
      );
    }
  },
});

function callbackResponseFrom(
  response: SynologyResponse<any> | ConnectionFailure,
): CallbackResponse {
  if (isConnectionFailure(response)) {
    return {
      failMessage: errorMessageFromConnectionFailure(response),
    };
  } else if (!response.success) {
    return {
      failMessage: errorMessageFromCode(response.error.code, "DownloadStation.Task"),
    };
  } else {
    return "success";
  }
}

const MESSAGE_HANDLERS: MessageHandlers = {
  "add-tasks": (m) => {
    return addDownloadTasksAndPoll(api, showNonErrorNotifications, m.urls, m.path);
  },
  "poll-tasks": (_m) => {
    return pollTasks(api);
  },
  "pause-task": async (m) => {
    const response = callbackResponseFrom(await api.DownloadStation.Task.Pause({ id: [m.taskId] }));
    if (response === "success") {
      await pollTasks(api);
    }
    return response;
  },
  "resume-task": async (m) => {
    const response = callbackResponseFrom(
      await api.DownloadStation.Task.Resume({ id: [m.taskId] }),
    );
    if (response === "success") {
      await pollTasks(api);
    }
    return response;
  },
  "delete-tasks": async (m) => {
    const response = callbackResponseFrom(
      await api.DownloadStation.Task.Delete({ id: m.taskIds, force_complete: false }),
    );
    if (response === "success") {
      await pollTasks(api);
    }
    return response;
  },
};

browser.runtime.onMessage.addListener((m) => {
  if (maybeIsMessage(m)) {
    const handler = (MESSAGE_HANDLERS as any)[m.type];
    if (handler != null) {
      return handler(m);
    }
  }
  console.error("received unhandleable message", m);
  return undefined;
});

updateStateShapeIfNecessary()
  .then(() => {
    onStoredStateChange((storedState) => {
      const didUpdateSettings = api.updateSettings({
        baseUrl: getHostUrl(storedState.settings.connection),
        account: storedState.settings.connection.username,
        passwd: storedState.settings.connection.password,
        session: SessionName.DownloadStation,
      });

      if (didUpdateSettings) {
        const clearCachePromise = clearCachedTasks();

        if (didInitializeSettings) {
          // Don't use await because we want this to fire in the background.
          clearCachePromise.then(() => {
            pollTasks(api);
          });
        }

        // This is a little bit of a hack, but basically: onStoredStateChange eagerly fires this
        // listener when it initializes. That first time through, the client gets initialized for
        // the first time, and so we necessarily clear and reload. However, if the user hasn't
        // configured notifications, we should try to avoid pinging the NAS, since we know we're
        // opening in the background. Hence this boolean. If notifications are enabled, those'll
        // still get set up and we'll starting pinging in the background.
        didInitializeSettings = true;
      }

      if (!isEqual(storedState.settings.notifications, lastNotificationSettings)) {
        lastNotificationSettings = storedState.settings.notifications;
        clearInterval(notificationInterval!);
        if (lastNotificationSettings.enableCompletionNotifications) {
          notificationInterval = (setInterval(() => {
            pollTasks(api);
          }, lastNotificationSettings.completionPollingInterval * 1000) as any) as number;
        }
      }

      showNonErrorNotifications = storedState.settings.notifications.enableFeedbackNotifications;

      if (storedState.taskFetchFailureReason) {
        browser.browserAction.setIcon({
          path: {
            "16": "icons/icon-16-disabled.png",
            "32": "icons/icon-32-disabled.png",
            "64": "icons/icon-64-disabled.png",
            "128": "icons/icon-128-disabled.png",
            "256": "icons/icon-256-disabled.png",
          },
        });

        browser.browserAction.setBadgeText({
          text: "",
        });

        browser.browserAction.setBadgeBackgroundColor({ color: [217, 0, 0, 255] });
      } else {
        browser.browserAction.setIcon({
          path: {
            "16": "icons/icon-16.png",
            "32": "icons/icon-32.png",
            "64": "icons/icon-64.png",
            "128": "icons/icon-128.png",
            "256": "icons/icon-256.png",
          },
        });

        let taskCount;
        if (storedState.settings.badgeDisplayType === "total") {
          taskCount = storedState.tasks.length;
        } else if (storedState.settings.badgeDisplayType === "filtered") {
          taskCount = filterTasks(storedState.tasks, storedState.settings.visibleTasks).length;
        } else {
          assertNever(storedState.settings.badgeDisplayType);
          return; // Can't `return assertNever(...)` because the linter complains.
        }

        browser.browserAction.setBadgeText({
          text: taskCount === 0 ? "" : taskCount.toString(),
        });

        browser.browserAction.setBadgeBackgroundColor({ color: [0, 217, 0, 255] });
      }

      if (
        storedState.tasksLastCompletedFetchTimestamp != null &&
        storedState.tasksLastCompletedFetchTimestamp > START_TIME &&
        storedState.taskFetchFailureReason == null
      ) {
        const updatedFinishedTaskIds = storedState.tasks
          .filter((t) => t.status === "finished" || t.status === "seeding")
          .map((t) => t.id);
        if (
          finishedTaskIds != null &&
          storedState.settings.notifications.enableCompletionNotifications
        ) {
          updatedFinishedTaskIds
            .filter((id) => !finishedTaskIds!.has(id))
            .forEach((id) => {
              const task = storedState.tasks.find((t) => t.id === id)!;
              notify(`${task.title}`, browser.i18n.getMessage("Download_finished"));
            });
        }
        finishedTaskIds = new Set(updatedFinishedTaskIds);
      }
    });
  })
  .catch(onUnhandledError);
