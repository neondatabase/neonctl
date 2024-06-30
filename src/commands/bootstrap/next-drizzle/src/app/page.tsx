import styles from './page.module.css';

export const runtime = 'edge';

export default async function Home() {
  return <main className={styles.main}>Hello World!</main>;
}
