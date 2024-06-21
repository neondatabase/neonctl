export default function SignUpPage() {
  return (
    <>
      <h1>Sign up</h1>
      <form method="post" action="/api/signup">
        <label htmlFor="name">First and Last Name</label>
        <input id="name" name="name" />
        <label htmlFor="email">Email</label>
        <input id="email" name="email" />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" />
        <button>Sign Up</button>
      </form>
    </>
  );
}
