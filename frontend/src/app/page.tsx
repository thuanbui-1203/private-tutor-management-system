// Placeholder home page. Real screens are built in the frontend issues.
export default function Home() {
  return (
    <main className="placeholder">
      <h1>Tutor Management System</h1>
      <p>Frontend scaffold. API gateway: {process.env.NEXT_PUBLIC_API_URL ?? '(chưa cấu hình)'}</p>
    </main>
  );
}
