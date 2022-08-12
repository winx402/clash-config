/*
 * 由@mieqq编写
 * 原脚本地址：https://raw.githubusercontent.com/mieqq/mieqq/master/sub_info_panel.js
 * https://raw.githubusercontent.com/Rabbit-Spec/Surge/Master/Panel/Sub-info/Sub-info.js
 * 由@Rabbit-Spec修改
 * 更新日期：2022.06.29
 * 版本：1.7
*/

let args = getArgs();

(async () => {
  let info = await getDataInfo(args.url);
  console.log('test4');
  if (!info) $done();
  let resetDayLeft = getRmainingDays(parseInt(args["reset_day"]));

  let used = info.bw_counter_b;
  let total = info.monthly_bw_limit_b;
  let surplus = info.total - used;
  let expire = args.expire || info.bw_reset_day_of_month;
  let content = [`用量：${bytesToSize(used)} | ${bytesToSize(total)}`];
  content.push(`剩余：${bytesToSizeMaxGB(surplus)}`);
  console.log('test4');
  if (resetDayLeft) {
    content.push(`重置：剩余${resetDayLeft}天`);
  }
  console.log('test4');
  if (expire && expire !== "false") {
    if (/^[\d.]+$/.test(expire)) expire *= 1000;
    content.push(`到期：${formatTime(expire)}`);
  }

  let now = new Date();
  let hour = now.getHours();
  let minutes = now.getMinutes();
  hour = hour > 9 ? hour : "0" + hour;
  minutes = minutes > 9 ? minutes : "0" + minutes;
  console.log('test4');
  $done({
    title: `${args.title} | ${hour}:${minutes}`,
    content: content.join("\n"),
    icon: args.icon || "airplane.circle",
    "icon-color": args.color || "#007aff",
  });
})();

function getArgs() {
  return Object.fromEntries(
    $argument
      .split("&")
      .map((item) => item.split("="))
      .map(([k, v]) => [k, decodeURIComponent(v)])
  );
}

function getUserInfo(url) {
  let method = args.method || "get";
  let request = { headers: { "User-Agent": "Quantumult%20X" }, url };
  return new Promise((resolve, reject) =>
    $httpClient[method](request, (err, resp, data) => {
      if (err != null) {
        reject(err);
        return;
      }
      if (resp.status !== 200) {
        reject(resp.status);
        return;
      }
      resolve(data);
    })
  );
}

async function getDataInfo(url) {
  const [err, data] = await getUserInfo(url)
    .then((data) => [null, data])
    .catch((err) => [err, null]);
  console.log('test4');
  if (err) {
    console.log(err);
    return;
  }
  return JSON.parse(data);
  
  // return Object.fromEntries(
  //   data
  //     .match(/\w+=[\d.eE+]+/g)
  //     .map((item) => item.split("="))
  //     .map(([k, v]) => [k, Number(v)])
  // );
}

function getRmainingDays(resetDay) {
  if (!resetDay) return;

  let now = new Date();
  let today = now.getDate();
  let month = now.getMonth();
  let year = now.getFullYear();
  let daysInMonth;

  if (resetDay > today) {
    daysInMonth = 0;
  } else {
    daysInMonth = new Date(year, month + 1, 0).getDate();
  }

  return daysInMonth - today + resetDay;
}

function bytesToSize(bytes) {
  if (bytes === 0) return "0B";
  let k = 1024;
  sizes = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
  let i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(2) + " " + sizes[i];
}

function bytesToSizeMaxGB(bytes) {
  if (bytes === 0) return "0B";
  sizes = ["B", "KB", "MB", "GB"];
  let k = 1024;
  if (bytes < k) {
    return bytes.toFixed(3) + " B";
  }
  bytes = bytes / k;
  if (bytes < k) {
    return bytes.toFixed(3) + " KB";
  }
  bytes = bytes / k;
  if (bytes < k) {
    return bytes.toFixed(3) + " MB";
  }
  bytes = bytes / k;
  return bytes.toFixed(3) + " GB";
}

function formatTime(time) {
  let dateObj = new Date(time);
  let year = dateObj.getFullYear();
  let month = dateObj.getMonth() + 1;
  let day = dateObj.getDate();
  return year + "年" + month + "月" + day + "日";
}
