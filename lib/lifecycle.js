/** A deadline reports failure without canceling underlying work. */
export async function deadline(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(label + ' timed out; database remains open'), { code: 'STOP_TIMEOUT' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}
