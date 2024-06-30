import styles from './page.module.css';
import { SignIn } from '@/components/auth/signin-button';
import { SignOut } from '@/components/auth/signout-button';
import { auth } from '@/lib/auth';

export const runtime = 'edge';

export default async function Home() {
  const session = await auth();

  let inner;
  if (!session?.user) {
    inner = (
      <div>
        You are not signed in.
        <div>
          <SignIn />
        </div>
      </div>
    );
  } else {
    inner = (
      <div>
        <div>Hello {session.user.name}!</div>
        <SignOut />
      </div>
    );
  }

  return <main className={styles.main}>{inner}</main>;
}
