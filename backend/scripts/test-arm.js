// D:\AI_Projects\xbot\backend\scripts\test-arm.js
async function arm() {
  try {
    const res = await fetch('http://localhost:3011/api/system/arm', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer xbot_admin_2026',
        'Content-Type': 'application/json'
      }
    });
    const data = await res.json();
    console.log('--- Arm Engine Response ---');
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Arm API call failed:', err.message);
  }
}
arm();
